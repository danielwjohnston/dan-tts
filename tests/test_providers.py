"""The hosted providers (Azure, Google, Polly, OpenAI) and their shared helpers, offline: HTTP and
WebSocket calls are replaced with canned answers. The Worker's tests (worker/test/) check the same cases."""
import asyncio
import base64
import json
from datetime import datetime, timezone

import aiohttp
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main
from app.providers import azure, common, google, openai_tts, polly


def mp3(n, id3=False, tag=False):
    """n silent frames of MPEG-2 Layer III, 24 kHz, 48 kbps: 144 bytes and 24 ms (240,000 ticks) each."""
    frames = b"".join(bytes([0xFF, 0xF3, 0x64, 0xC0, i]) + bytes(139) for i in range(n))
    head = (b"ID3\x04\x00\x00\x00\x00\x00\x14" + bytes([7] * 20)) if id3 else b""
    return head + frames + ((b"TAG" + bytes([1] * 125)) if tag else b"")


def run(coro):
    return asyncio.run(coro)


# ---- common ----

def test_mp3_frames_measure_mpeg2_and_mpeg1_and_skip_tags():
    assert common.mp3_ticks(mp3(10)) == 2_400_000
    frames, ticks = common.mp3_frames(mp3(10, id3=True, tag=True))
    assert ticks == 2_400_000 and len(frames) == 1440 and frames[:4] == bytes([0xFF, 0xF3, 0x64, 0xC0])
    mpeg1 = b"".join(bytes([0xFF, 0xFB, 0x90, 0xC0]) + bytes(413) for _ in range(3))
    assert common.mp3_ticks(mpeg1) == 3 * 261224
    assert common.mp3_frames(bytes([1, 2, 3, 0xFF, 0xFB])) == (b"", 0)
    assert common.mp3_ticks(b"not audio at all, really") == 0


def test_join_pieces_concatenates_frames_and_shifts_boundaries():
    a = (mp3(10, id3=True), [{"offset": 0, "duration": 1_000_000, "text": "One"}])
    b = (mp3(5), [{"offset": 100_000, "duration": 500_000, "text": "two"}])
    audio, boundaries, ticks = common.join_pieces([a, b])
    assert ticks == 3_600_000 and len(audio) == 15 * 144
    assert boundaries == [{"offset": 0, "duration": 1_000_000, "text": "One"}, {"offset": 2_500_000, "duration": 500_000, "text": "two"}]
    audio, _, ticks = common.join_pieces([a])
    assert audio is a[0] and ticks == 2_400_000


def test_estimate_boundaries_matches_the_worker():
    b = common.estimate_boundaries("Hi there, world.", 10_000_000)
    # weights: Hi 3, there 6 + 1.5 pause, world 6 + 3 pause → 19.5
    assert [x["text"] for x in b] == ["Hi", "there,", "world."]
    assert b[0] == {"offset": 0, "duration": int(10_000_000 * 3 / 19.5), "text": "Hi"}
    assert b[1]["offset"] == int(10_000_000 * 3 / 19.5)
    assert b[2]["offset"] == int(10_000_000 * 10.5 / 19.5)
    assert b[2]["offset"] + b[2]["duration"] == int(10_000_000 * 16.5 / 19.5)
    assert common.estimate_boundaries("  ", 5) == [] and common.estimate_boundaries("Hi", 0) == []
    assert common.estimate_boundaries("café —", 1000)[1]["text"] == "—"


def test_pieces_keep_paragraphs_split_sentences_and_never_cut_a_break_tag():
    assert common.pieces("One.\n\nTwo.", 100) == ["One.\n\nTwo."]
    assert common.pieces("One.\n\nTwo.", 6) == ["One.", "Two."]
    long = "A sentence here. " * 50
    out = common.pieces(long, 100)
    assert len(out) >= 8 and all(len(p) <= 100 and p.endswith(".") for p in out)
    assert " ".join(out) == long.strip()
    run_on = "word " * 60 + '<break time="1.5s" /> ' + "word " * 60
    for p in common.pieces(run_on, 70):
        assert len(p) <= 70 and p.count("<break") == p.count("/>"), p
    assert common.pieces("   \n\n ", 10) == []


def test_ssml_helpers():
    assert common.ssml_body("Tom & Jerry <b>", 3000) == "Tom &amp; Jerry &lt;b&gt;"
    assert common.ssml_body('Wait <break time="0.4s" /> here <break time="9s"/>', 3000) == 'Wait <break time="400ms"/> here <break time="3000ms"/>'
    assert common.ssml_body("a\x0bb") == "a b"
    assert common.has_breaks('x <break time="1s"/> y') and not common.has_breaks("x < y")
    body, words = common.ssml_with_marks('Hi there, <break time="0.4s" /> "you" & me')
    assert words == ["Hi", "there,", '"you"', "&", "me"]
    assert body == '<mark name="0"/>Hi <mark name="1"/>there, <break time="400ms"/> <mark name="2"/>&quot;you&quot; <mark name="3"/>&amp; <mark name="4"/>me'


def test_locales_from_the_environment(monkeypatch):
    assert common.locales() == ["en-US"]
    monkeypatch.setenv("VOICE_LOCALES", "en-GB, de-DE")
    assert common.locales() == ["en-GB", "de-DE"]
    monkeypatch.setenv("VOICE_LOCALES", "*")
    assert common.locales() == []
    assert common.locale_ok(["en-US"], "en-us") and not common.locale_ok(["en-US"], "de-DE") and common.locale_ok([], "xx")


def fake_fetch(module, monkeypatch, handler):
    """Replace a module's HTTP call: handler(method, url, headers, json_body, data) → (status, headers, body)."""
    calls = []

    async def fetch(name, method, url, *, headers=None, json_body=None, data=None, timeout=60):
        calls.append({"method": method, "url": url, "headers": headers or {}, "json": json_body, "data": data})
        return handler(method, url, headers or {}, json_body, data)

    monkeypatch.setattr(module, "fetch", fetch)
    return calls


# ---- Azure ----

def test_azure_ids_and_voice_list(monkeypatch):
    assert azure.ID_RE.match("azure:en-US-JennyNeural") and azure.ID_RE.match("azure:en-US-Ava:DragonHDLatestNeural") and azure.ID_RE.match("azure:zh-CN-shaanxi-XiaoniNeural")
    assert not azure.ID_RE.match("azure:") and not azure.ID_RE.match("azure:../x") and not azure.ID_RE.match("en-US-AriaNeural") and not azure.ID_RE.match("azure:en-US-JennyNeural\n")
    monkeypatch.setattr(azure, "KEY", "k")
    monkeypatch.setattr(azure, "REGION", "eastus")
    listing = [
        {"ShortName": "en-US-JennyNeural", "DisplayName": "Jenny", "Locale": "en-US", "LocaleName": "English (United States)", "Gender": "Female", "StyleList": ["chat"], "VoiceType": "Neural"},
        {"ShortName": "de-DE-KatjaNeural", "DisplayName": "Katja", "Locale": "de-DE", "Gender": "Female"},
        {"ShortName": "en-US-Ava:DragonHDLatestNeural", "DisplayName": "Ava Dragon HD Latest", "Locale": "en-US", "LocaleName": "English (United States)", "Gender": "Female", "VoiceType": "NeuralHD"},
    ]
    calls = fake_fetch(azure, monkeypatch, lambda *a: (200, {}, json.dumps(listing).encode()))
    voices = run(azure.list_voices())
    assert calls[0]["url"] == "https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list"
    assert calls[0]["headers"] == {"Ocp-Apim-Subscription-Key": "k"}
    assert [(v["shortName"], v["name"], v["provider"], v["gender"], v["localeName"]) for v in voices] == [
        ("azure:en-US-JennyNeural", "Jenny", "azure", "Female", "English (United States)"),
        ("azure:en-US-Ava:DragonHDLatestNeural", "Ava Dragon HD Latest", "azure", "Female", "English (United States) · NeuralHD"),
    ]
    assert voices[0]["styleList"] == ["chat"]
    monkeypatch.setenv("VOICE_LOCALES", "*")
    assert len(run(azure.list_voices())) == 3
    fake_fetch(azure, monkeypatch, lambda *a: (401, {}, b"denied"))
    with pytest.raises(HTTPException) as e:
        run(azure.list_voices())
    assert e.value.status_code == 502 and "rejected the key or region" in e.value.detail


class FakeWs:
    """An open speech socket that answers the SSML with a scripted turn."""

    def __init__(self, script):
        self.script, self.sent = script, []

    async def send_str(self, s):
        self.sent.append(s)

    def __aiter__(self):
        async def gen():
            for m in self.script:
                yield m
        return gen()


class Msg:
    def __init__(self, type_, data):
        self.type, self.data = type_, data


def text_frame(path, body):
    return Msg(aiohttp.WSMsgType.TEXT, f"X-RequestId:abc\r\nContent-Type:application/json\r\nPath:{path}\r\n\r\n{body}")


def binary_frame(audio):
    header = b"X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n"
    return Msg(aiohttp.WSMsgType.BINARY, len(header).to_bytes(2, "big") + header + audio)


def meta(text, offset, duration, kind="WordBoundary"):
    return text_frame("audio.metadata", json.dumps({"Metadata": [{"Type": "WordBoundary", "Data": {"Offset": offset, "Duration": duration, "text": {"Text": text, "BoundaryType": kind}}}]}))


def test_azure_speaks_the_engine_protocol_and_keeps_words_only():
    script = [text_frame("turn.start", "{}"), meta("Hello", 1000000, 4000000), meta(",", 5000000, 100000, "PunctuationBoundary"),
              binary_frame(mp3(3)), meta("&amp;there", 6000000, 3000000), text_frame("turn.end", "{}")]
    ws = FakeWs(script)
    audio, boundaries = run(azure.speak_on(ws, azure.ssml_for('Hello, <break time="0.4s" /> there & co', "en-US-JennyNeural")))
    assert boundaries == [{"offset": 1000000, "duration": 4000000, "text": "Hello"}, {"offset": 6000000, "duration": 3000000, "text": "&there"}]
    assert len(audio) == 3 * 144
    assert "Path:speech.config" in ws.sent[0] and '"wordBoundaryEnabled":"true"' in ws.sent[0]
    assert ws.sent[1].split("\r\n\r\n", 1)[1] == (
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'>"
        "<voice name='en-US-JennyNeural'>Hello, <break time=\"400ms\"/> there &amp; co</voice></speak>")
    with pytest.raises(HTTPException) as e:
        run(azure.speak_on(FakeWs([text_frame("turn.end", "{}")]), "<speak/>"))
    assert e.value.status_code == 502 and "no audio" in e.value.detail


def test_azure_synthesize_validates_then_speaks_in_pieces(monkeypatch):
    spoken = []

    async def fake_speak(ssml):
        spoken.append(ssml)
        return mp3(2), [{"offset": 0, "duration": 100, "text": "x"}]

    monkeypatch.setattr(azure, "_speak", fake_speak)
    with pytest.raises(HTTPException) as e:
        run(azure.synthesize("hi", "azure:en-US-JennyNeural"))
    assert e.value.status_code == 503 and "AZURE_SPEECH_KEY" in e.value.detail
    monkeypatch.setattr(azure, "KEY", "k")
    monkeypatch.setattr(azure, "REGION", "eastus")
    with pytest.raises(HTTPException) as e:
        run(azure.synthesize("hi", "azure:bad"))
    assert e.value.status_code == 400
    audio, boundaries = run(azure.synthesize("One.\n\n" + "word " * 2000, "azure:en-US-JennyNeural"))
    assert len(spoken) == 3 and all(len(s) < 8400 for s in spoken)  # "One.", then the run-on in two
    assert [b["offset"] for b in boundaries] == [0, 480_000, 960_000]  # each piece starts after the 2 frames before it
    assert len(audio) == 6 * 144


# ---- Google ----

def test_google_voices_and_marks(monkeypatch):
    assert google.ID_RE.match("google:en-US-Neural2-F") and google.ID_RE.match("google:en-US-Chirp3-HD-Aoede") and not google.ID_RE.match("google:x") and not google.ID_RE.match("google:en-US-Neural2/F")
    assert google.takes_ssml("en-US-Neural2-F") and not google.takes_ssml("en-US-Chirp3-HD-Aoede") and not google.takes_ssml("en-US-Journey-D")
    monkeypatch.setattr(google, "KEY", "g")

    def handler(method, url, headers, body, data):
        assert headers == {"x-goog-api-key": "g"}
        if url.startswith("https://texttospeech.googleapis.com/v1/voices"):
            return 200, {}, json.dumps({"voices": [
                {"languageCodes": ["en-US"], "name": "en-US-Neural2-F", "ssmlGender": "FEMALE"},
                {"languageCodes": ["en-US"], "name": "en-US-Chirp3-HD-Aoede", "ssmlGender": "FEMALE"},
                {"languageCodes": ["en-US"], "name": "en-US-Studio-O", "ssmlGender": "NEUTRAL"},
            ]}).encode()
        if "ssml" in body["input"]:
            assert body["enableTimePointing"] == ["SSML_MARK"]
            assert body["input"]["ssml"] == '<speak><mark name="0"/>Hi <mark name="1"/>there</speak>'
            assert body["voice"] == {"languageCode": "en-US", "name": "en-US-Neural2-F"}
            return 200, {}, json.dumps({"audioContent": base64.b64encode(mp3(10)).decode(), "timepoints": [{"markName": "0", "timeSeconds": 0.1}, {"markName": "1", "timeSeconds": 0.14}]}).encode()
        assert "enableTimePointing" not in body
        return 200, {}, json.dumps({"audioContent": base64.b64encode(mp3(10)).decode()}).encode()

    calls = fake_fetch(google, monkeypatch, handler)
    voices = run(google.list_voices())
    assert calls[0]["url"] == "https://texttospeech.googleapis.com/v1/voices?languageCode=en-US"
    assert [(v["shortName"], v["name"], v["gender"], v["localeName"]) for v in voices] == [
        ("google:en-US-Neural2-F", "Neural2 F", "Female", "en-US"),
        ("google:en-US-Chirp3-HD-Aoede", "Chirp3 HD Aoede", "Female", "en-US · Timings estimated"),
        ("google:en-US-Studio-O", "Studio O", "", "en-US"),
    ]
    audio, boundaries = run(google.synthesize("Hi there", "google:en-US-Neural2-F"))
    assert len(audio) == 1440
    assert boundaries == [{"offset": 1_000_000, "duration": 400_000, "text": "Hi"}, {"offset": 1_400_000, "duration": 1_000_000, "text": "there"}]
    _, est = run(google.synthesize("Hi there", "google:en-US-Chirp3-HD-Aoede"))
    assert [b["text"] for b in est] == ["Hi", "there"] and est[1]["offset"] + est[1]["duration"] == 2_400_000


def test_google_marked_pieces_and_errors(monkeypatch):
    text = ("a " * 400 + "\n\n") * 3
    parts = google.marked_pieces(text)
    assert len(parts) >= 3 and all(len(f"<speak>{common.ssml_with_marks(p)[0]}</speak>".encode()) <= 5000 for p in parts)
    with pytest.raises(HTTPException) as e:
        run(google.synthesize("hi", "google:en-US-Neural2-F"))
    assert e.value.status_code == 503 and "GOOGLE_TTS_API_KEY" in e.value.detail
    monkeypatch.setattr(google, "KEY", "g")
    with pytest.raises(HTTPException) as e:
        run(google.synthesize("hi", "google:bad"))
    assert e.value.status_code == 400

    def expect(status, message, code, words):
        fake_fetch(google, monkeypatch, lambda *a: (status, {}, json.dumps({"error": {"code": status, "message": message}}).encode()))
        with pytest.raises(HTTPException) as e:
            run(google.synthesize("hi", "google:en-US-Neural2-F"))
        assert e.value.status_code == code and words in e.value.detail

    expect(400, "API key not valid. Please pass a valid API key.", 502, "rejected the API key")
    expect(429, "Quota exceeded", 429, "quota")
    expect(400, "Voice en-US-Neural2-F does not exist", 400, "No such")


# ---- Polly ----

def test_polly_signing_matches_the_aws_worked_example(monkeypatch):
    assert polly.signing_key("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam").hex() == "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
    h = polly.sign_v4("POST", "https://polly.us-west-2.amazonaws.com/v1/speech", '{"a":1}', now=datetime(2026, 10, 26, 12, 34, 56, tzinfo=timezone.utc),
                      access_key="AKIDEXAMPLE", secret_key="wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", session_token="", region="us-west-2")
    assert h["x-amz-date"] == "20261026T123456Z" and "host" not in h
    assert h["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261026/us-west-2/polly/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=")
    assert len(h["Authorization"].rsplit("=", 1)[1]) == 64
    t = polly.sign_v4("GET", "https://polly.us-west-2.amazonaws.com/v1/voices?LanguageCode=en-US", access_key="a", secret_key="s", session_token="tok", region="us-west-2")
    assert "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token," in t["Authorization"] and t["x-amz-security-token"] == "tok"


def test_polly_voices_then_audio_and_marks(monkeypatch):
    monkeypatch.setattr(polly, "ACCESS_KEY", "AKIDEXAMPLE")
    monkeypatch.setattr(polly, "SECRET_KEY", "secret")
    monkeypatch.setattr(polly, "REGION", "us-west-2")
    marks = '{"time":6,"type":"word","start":0,"end":5,"value":"Hello"}\n{"time":120,"type":"word","start":6,"end":11,"value":"world"}\n'

    def handler(method, url, headers, body, data):
        assert headers["Authorization"].startswith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/")
        if url.startswith("https://polly.us-west-2.amazonaws.com/v1/voices"):
            if "NextToken=" in url:
                return 200, {}, json.dumps({"Voices": [{"Id": "Matthew", "Name": "Matthew", "Gender": "Male", "LanguageCode": "en-US", "LanguageName": "US English", "SupportedEngines": ["neural", "standard"]}]}).encode()
            return 200, {}, json.dumps({"Voices": [
                {"Id": "Joanna", "Name": "Joanna", "Gender": "Female", "LanguageCode": "en-US", "LanguageName": "US English", "SupportedEngines": ["neural", "standard", "generative"]},
                {"Id": "Kendra", "Name": "Kendra", "Gender": "Female", "LanguageCode": "en-US", "LanguageName": "US English", "SupportedEngines": ["standard"]},
            ], "NextToken": "n2"}).encode()
        req = json.loads(data)
        assert (req["VoiceId"], req["Engine"], req["TextType"]) == ("Joanna", "neural", "text")
        if req["OutputFormat"] == "mp3":
            return 200, {}, mp3(10)
        assert req["SpeechMarkTypes"] == ["word"]
        return 200, {}, marks.encode()

    calls = fake_fetch(polly, monkeypatch, handler)
    voices = run(polly.list_voices())
    assert calls[0]["url"] == "https://polly.us-west-2.amazonaws.com/v1/voices?LanguageCode=en-US"
    assert [(v["shortName"], v["name"], v["gender"], v["localeName"]) for v in voices] == [
        ("polly:Joanna", "Joanna", "Female", "US English"), ("polly:Kendra", "Kendra", "Female", "US English · standard"), ("polly:Matthew", "Matthew", "Male", "US English")]
    audio, boundaries = run(polly.synthesize("Hello world", "polly:Joanna"))
    assert len(audio) == 1440
    assert boundaries == [{"offset": 60_000, "duration": 1_140_000, "text": "Hello"}, {"offset": 1_200_000, "duration": 1_200_000, "text": "world"}]
    assert sum(1 for c in calls if c["url"].endswith("/v1/speech")) == 2


def test_polly_ssml_engine_fallback_and_errors(monkeypatch):
    monkeypatch.setattr(polly, "ACCESS_KEY", "a")
    monkeypatch.setattr(polly, "SECRET_KEY", "s")
    engines = []

    def handler(method, url, headers, body, data):
        req = json.loads(data)
        engines.append(req["Engine"])
        if req["Engine"] == "neural":
            return 400, {"x-amzn-errortype": "EngineNotSupportedException:http://internal.amazon.com/coral/com.amazon.polly/"}, b'{"message":"This voice does not support the selected engine: neural"}'
        assert req["TextType"] == "ssml" and req["Text"] == '<speak>Wait <break time="800ms"/> here</speak>'
        return (200, {}, mp3(2)) if req["OutputFormat"] == "mp3" else (200, {}, b'{"time":0,"type":"word","start":7,"end":11,"value":"Wait"}\n')

    fake_fetch(polly, monkeypatch, handler)
    _, boundaries = run(polly.synthesize('Wait <break time="0.8s" /> here', "polly:Kendra"))
    assert engines == ["neural", "neural", "standard", "standard"]
    assert boundaries == [{"offset": 0, "duration": 480_000, "text": "Wait"}]
    with pytest.raises(HTTPException) as e:
        run(polly.synthesize("hi", "polly:no such"))
    assert e.value.status_code == 400

    def expect(status, kind, message, code, words):
        fake_fetch(polly, monkeypatch, lambda *a: (status, {"x-amzn-errortype": kind}, json.dumps({"message": message}).encode()))
        with pytest.raises(HTTPException) as e:
            run(polly.synthesize("hi", "polly:Joanna"))
        assert e.value.status_code == code and words in e.value.detail

    expect(403, "InvalidSignatureException", "bad sig", 502, "rejected the credentials")
    expect(400, "TextLengthExceededException", "", 422, "too long")
    expect(400, "ThrottlingException", "", 429, "rate-limiting")
    expect(400, "ValidationException", "1 validation error detected: Value 'Nobody' at 'voiceId'", 400, "No such Amazon Polly voice")
    monkeypatch.setattr(polly, "ACCESS_KEY", "")
    with pytest.raises(HTTPException) as e:
        run(polly.synthesize("hi", "polly:Joanna"))
    assert e.value.status_code == 503 and "AWS_ACCESS_KEY_ID" in e.value.detail


# ---- OpenAI ----

def test_openai_fixed_voices_audio_in_estimates_out(monkeypatch):
    voices = run(openai_tts.list_voices())
    assert [(v["shortName"], v["name"], v["provider"], v["localeName"]) for v in voices[:2]] == [("openai:alloy", "Alloy", "openai", "Timings estimated"), ("openai:ash", "Ash", "openai", "Timings estimated")]
    assert all(openai_tts.ID_RE.match(v["shortName"]) for v in voices)
    monkeypatch.setattr(openai_tts, "KEY", "sk")
    monkeypatch.setattr(openai_tts, "MODEL", "tts-1")
    calls = fake_fetch(openai_tts, monkeypatch, lambda *a: (200, {}, mp3(10)))
    audio, boundaries = run(openai_tts.synthesize("Hello there, world.", "openai:alloy"))
    assert calls[0]["url"] == "https://api.openai.com/v1/audio/speech" and calls[0]["headers"] == {"Authorization": "Bearer sk"}
    assert calls[0]["json"] == {"model": "tts-1", "input": "Hello there, world.", "voice": "alloy", "response_format": "mp3"}
    assert len(audio) == 1440 and [b["text"] for b in boundaries] == ["Hello", "there,", "world."]
    assert boundaries[0]["offset"] == 0 and boundaries[2]["offset"] + boundaries[2]["duration"] <= 2_400_000


def test_openai_validation_and_errors(monkeypatch):
    with pytest.raises(HTTPException) as e:
        run(openai_tts.synthesize("hi", "openai:alloy"))
    assert e.value.status_code == 503 and "OPENAI_API_KEY" in e.value.detail
    monkeypatch.setattr(openai_tts, "KEY", "sk")
    with pytest.raises(HTTPException) as e:
        run(openai_tts.synthesize("hi", "openai:Alloy"))
    assert e.value.status_code == 400

    def expect(status, error, code, words):
        fake_fetch(openai_tts, monkeypatch, lambda *a: (status, {}, json.dumps({"error": error}).encode()))
        with pytest.raises(HTTPException) as e:
            run(openai_tts.synthesize("hi", "openai:alloy"))
        assert e.value.status_code == code and words in e.value.detail

    expect(401, {"message": "Incorrect API key provided"}, 502, "rejected the API key (Incorrect API key provided)")
    expect(429, {"type": "insufficient_quota", "message": "You exceeded your current quota"}, 429, "out of credit")
    expect(429, {"type": "requests", "message": "Rate limit reached"}, 429, "rate-limiting")
    expect(400, {"param": "voice", "message": "'zzzz' is not one of ..."}, 400, "No such OpenAI voice")
    fake_fetch(openai_tts, monkeypatch, lambda *a: (200, {}, b""))
    with pytest.raises(HTTPException) as e:
        run(openai_tts.synthesize("hi", "openai:alloy"))
    assert e.value.status_code == 502 and "no audio" in e.value.detail


# ---- Routing in app/main.py ----

def test_health_lists_every_configured_provider_in_order(monkeypatch):
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "e")
    monkeypatch.setattr(azure, "KEY", "a")
    monkeypatch.setattr(azure, "REGION", "eastus")
    monkeypatch.setattr(google, "KEY", "g")
    monkeypatch.setattr(polly, "ACCESS_KEY", "i")
    monkeypatch.setattr(polly, "SECRET_KEY", "s")
    monkeypatch.setattr(openai_tts, "KEY", "o")
    with TestClient(main.app) as c:
        assert c.get("/health").json()["providers"] == ["edge", "elevenlabs", "azure", "google", "polly", "openai"]
    monkeypatch.setattr(azure, "REGION", "")  # Azure needs both its key and its region
    assert main._providers() == ["edge", "elevenlabs", "google", "polly", "openai"]


@pytest.fixture
def client(monkeypatch):
    async def fake_edge_list():
        return [{"Name": "Aria", "ShortName": "en-US-AriaNeural", "Locale": "en-US", "Gender": "Female"}]

    monkeypatch.setattr(main.edge_tts, "list_voices", fake_edge_list)
    monkeypatch.setattr(main, "_voice_cache", None)
    with TestClient(main.app) as c:
        yield c


def test_provider_voices_rejected_clearly_without_keys(client):
    for voice, key in [("azure:en-US-JennyNeural", "AZURE_SPEECH_KEY"), ("google:en-US-Neural2-F", "GOOGLE_TTS_API_KEY"), ("polly:Joanna", "AWS_ACCESS_KEY_ID"), ("openai:alloy", "OPENAI_API_KEY")]:
        r = client.post("/synthesize", json={"text": "Hi", "voice": voice})
        assert r.status_code == 503 and key in r.json()["detail"], voice
        assert client.get(f"/samples/{voice}").status_code == 503, voice
    assert client.get("/samples/openai:ALLOY").status_code == 400
    assert client.get("/samples/polly:Jo%20anna").status_code == 400


def test_voices_merge_every_provider_and_survive_a_failed_one(client, monkeypatch):
    monkeypatch.setattr(openai_tts, "KEY", "o")
    monkeypatch.setattr(polly, "ACCESS_KEY", "i")
    monkeypatch.setattr(polly, "SECRET_KEY", "s")
    attempts = []

    async def failing():
        attempts.append(1)
        raise HTTPException(status_code=502, detail="Amazon Polly rejected the credentials")

    monkeypatch.setattr(polly, "list_voices", failing)
    voices = client.get("/voices").json()
    assert [v["provider"] for v in voices][:2] == ["edge", "openai"]
    assert voices[1]["sampleUrl"] == "/samples/openai:alloy"
    assert len([v for v in voices if v["provider"] == "openai"]) == len(openai_tts.VOICES)
    client.get("/voices")
    assert len(attempts) == 2  # a failure is not cached
    client.get("/voices?refresh=1")
    assert len(attempts) == 3


def test_provider_voices_route_for_timing_export_and_samples(client, monkeypatch, tmp_path):
    seen = []

    async def fake_synth(text, voice):
        seen.append((text, voice))
        return mp3(10), [{"offset": 0, "duration": 1_000_000, "text": "Hi"}, {"offset": 1_000_000, "duration": 1_400_000, "text": "there"}]

    monkeypatch.setattr(openai_tts, "KEY", "o")
    monkeypatch.setattr(openai_tts, "synthesize", fake_synth)
    monkeypatch.setattr(azure, "KEY", "a")
    monkeypatch.setattr(azure, "REGION", "eastus")
    monkeypatch.setattr(azure, "synthesize", fake_synth)
    monkeypatch.setattr(main, "SAMPLES_DIR", tmp_path)
    r = client.post("/synthesize_with_timing", json={"text": "Hi there", "voice": "openai:alloy"})
    assert r.status_code == 200 and [b["text"] for b in r.json()["boundaries"]] == ["Hi", "there"]
    assert base64.b64decode(r.json()["audio"]) == mp3(10)
    r = client.post("/export?format=srt", json={"text": "Hi there", "voice": "azure:en-US-JennyNeural"})
    assert r.status_code == 200 and "00:00:00,100 --> 00:00:00,240\nthere" in r.text
    r = client.get("/samples/azure:en-US-Ava:DragonHDLatestNeural")
    assert r.status_code == 200 and r.content == mp3(10)
    assert (tmp_path / "azure-en-US-Ava-DragonHDLatestNeural.mp3").exists()
    assert seen[-1] == (main.SAMPLE_TEXT, "azure:en-US-Ava:DragonHDLatestNeural")
    assert client.get("/samples/azure:en-US-Ava:DragonHDLatestNeural").status_code == 200 and len(seen) == 3  # served from disk
