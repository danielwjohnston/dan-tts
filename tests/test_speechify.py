"""The Speechify provider, offline: the HTTP helpers are replaced with canned responses."""
import asyncio
import base64

import pytest
from fastapi import HTTPException

from app import speechify

VOICE = "speechify:geffen_32"
AUDIO = b"ID3speechify"
MARKS = {
    "type": "sentence", "start": 0, "end": 8, "start_time": 0, "end_time": 950, "value": "Hi there",
    "chunks": [
        {"type": "word", "start": 0, "end": 2, "start_time": 0, "end_time": 200, "value": "Hi"},
        {"type": "word", "start": 3, "end": 8, "start_time": 300, "end_time": 950, "value": "there"},
    ],
}
LISTED = {"id": "geffen_32", "display_name": "Geffen", "type": "shared", "gender": "male", "locale": "en-US", "tags": ["timbre:deep"],
          "preview_audio": "https://cdn.example/geffen.mp3", "models": [{"name": "simba-3.5", "languages": [{"locale": "en-US", "preview_audio": "https://cdn.example/geffen-en.mp3"}]}]}


def test_voice_ids_are_speechify_prefixed():
    assert speechify.ID_RE.match(VOICE)
    assert speechify.ID_RE.match("speechify:9f2d8c1e-0b4a-4b2e-8b1a-1234567890ab")
    for bad in ("speechify:", "speechify:../x", "eleven:geffen_32", "en-US-AriaNeural", "speechify:geffen_32\n"):
        assert not speechify.ID_RE.match(bad), bad
    assert speechify.is_speechify_voice(VOICE) and not speechify.is_speechify_voice("en-US-AriaNeural")


def test_marks_to_boundaries_in_ticks_however_nested():
    assert speechify.marks_to_boundaries(MARKS) == [
        {"offset": 0, "duration": 2_000_000, "text": "Hi"},
        {"offset": 3_000_000, "duration": 6_500_000, "text": "there"},
    ]
    assert len(speechify.marks_to_boundaries([MARKS, {"chunks": [{"value": " ", "start_time": 1, "end_time": 2}]}])) == 2
    assert speechify.marks_to_boundaries({"value": "Solo", "start_time": 12.5, "end_time": 100}) == [{"offset": 125_000, "duration": 875_000, "text": "Solo"}]
    assert speechify.marks_to_boundaries(None) == []
    assert speechify.marks_to_boundaries({"chunks": []}) == []
    assert speechify.marks_to_boundaries({"chunks": [{"value": "x", "start_time": "bad", "end_time": None}]}) == [{"offset": 0, "duration": 0, "text": "x"}]


def test_to_input_wraps_and_escapes_only_with_markup_tags():
    assert speechify.to_input("Tom & Jerry <3") == "Tom & Jerry <3"
    assert speechify.to_input('Wait <break time="800ms"/> here & there') == '<speak>Wait <break time="800ms"/> here &amp; there</speak>'
    assert speechify.to_input('the <sub alias="Ker-nel">kernel</sub> panicked') == '<speak>the <sub alias="Ker-nel">kernel</sub> panicked</speak>'
    assert speechify.to_input('<prosody rate="slow">x</prosody> <break time="400ms" />') == '<speak>&lt;prosody rate=&quot;slow&quot;&gt;x&lt;/prosody&gt; <break time="400ms" /></speak>'


@pytest.mark.parametrize("status, body, retry, expected_status, words", [
    (401, '{"error": {"code": "unauthorized", "message": "bad key"}}', None, 502, "rejected the API key (bad key): check SPEECHIFY_API_KEY"),
    (402, '{"error": {"code": "insufficient_credits", "message": "no credits"}}', None, 429, "Edge voices still work"),
    (400, '{"error": {"code": "model_retired", "message": "simba-english is retired"}}', None, 502, f"SPEECHIFY_MODEL to {speechify.DEFAULT_MODEL}"),
    (400, '{"error": {"code": "content_policy_violation", "message": "nope"}}', None, 422, "content policy"),
    (400, '{"error": {"code": "validation_failed", "message": "input: malformed SSML"}}', None, 422, "rejected the request (input: malformed SSML)"),
    (404, '{"error": {"code": "not_found", "message": "voice"}}', None, 404, "No such Speechify voice"),
    (429, '{"error": {"code": "rate_limited", "message": "slow down"}}', "7", 429, "try again in 7 seconds"),
    (429, '{"error": {"code": "rate_limited"}}', None, 429, "try again in a moment"),
    (503, '{"error": {"code": "unavailable", "message": "down"}}', None, 502, "HTTP 503 (down)"),
    (500, "not json", None, 502, "HTTP 500"),
])
def test_errors_are_plain_language(status, body, retry, expected_status, words):
    exc = speechify.error_for(status, body, retry)
    assert exc.status_code == expected_status
    assert words in exc.detail


def test_synthesize_posts_the_speechify_request_shape(monkeypatch):
    seen = {}

    async def fake_json(key, method, path, json_body=None, timeout=60):
        seen.update(key=key, method=method, path=path, body=json_body)
        return {"audio_data": base64.b64encode(AUDIO).decode(), "audio_format": "mp3", "billable_characters_count": 8, "speech_marks": MARKS}

    monkeypatch.setattr(speechify, "request_json", fake_json)
    monkeypatch.setattr(speechify, "LANGUAGE", "")
    audio, boundaries = asyncio.run(speechify.synthesize("Hi there", VOICE, key="sk_test"))
    assert (seen["key"], seen["method"], seen["path"]) == ("sk_test", "POST", "/v1/audio/speech")
    assert seen["body"] == {"input": "Hi there", "voice_id": "geffen_32", "model": speechify.MODEL, "audio_format": "mp3"}
    assert audio == AUDIO and len(boundaries) == 2
    # Model and language settings reach the request; markup tags make the input SSML
    asyncio.run(speechify.synthesize('Wait <break time="400ms"/> go', VOICE, key="sk_test", model="simba-3.2", language="fr-FR"))
    assert seen["body"] == {"input": '<speak>Wait <break time="400ms"/> go</speak>', "voice_id": "geffen_32", "model": "simba-3.2", "audio_format": "mp3", "language": "fr-FR"}
    # The server-wide language setting applies when the call does not say
    monkeypatch.setattr(speechify, "LANGUAGE", "de-DE")
    asyncio.run(speechify.synthesize("Hallo", VOICE, key="sk_test"))
    assert seen["body"]["language"] == "de-DE"


def test_synthesize_rejects_bad_audio(monkeypatch):
    async def no_audio(*a, **k):
        return {"speech_marks": MARKS}

    async def bad_audio(*a, **k):
        return {"audio_data": "@@not base64@@"}

    monkeypatch.setattr(speechify, "request_json", no_audio)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(speechify.synthesize("hi", VOICE, key="k"))
    assert exc.value.status_code == 502 and "no audio" in exc.value.detail
    monkeypatch.setattr(speechify, "request_json", bad_audio)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(speechify.synthesize("hi", VOICE, key="k"))
    assert "unreadable audio" in exc.value.detail


def test_stream_returns_raw_bytes_with_the_longer_limit(monkeypatch):
    seen = {}

    async def fake_bytes(key, method, path, json_body=None, timeout=120, accept="audio/mpeg"):
        seen.update(path=path, body=json_body, accept=accept)
        return AUDIO, "audio/mpeg"

    monkeypatch.setattr(speechify, "request_bytes", fake_bytes)
    assert asyncio.run(speechify.stream_mp3("x" * (speechify.MAX_CHARS + 1), VOICE, key="k")) == AUDIO
    assert seen["path"] == "/v1/audio/stream" and seen["body"]["voice_id"] == "geffen_32" and seen["accept"] == "audio/mpeg"
    with pytest.raises(HTTPException) as exc:
        asyncio.run(speechify.stream_mp3("x" * (speechify.MAX_STREAM_CHARS + 1), VOICE, key="k"))
    assert exc.value.status_code == 422

    async def empty(*a, **k):
        return b"", ""

    monkeypatch.setattr(speechify, "request_bytes", empty)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(speechify.stream_mp3("hi", VOICE, key="k"))
    assert "no audio" in exc.value.detail


def test_requests_are_validated_before_network(monkeypatch):
    async def must_not_run(*a, **k):
        raise AssertionError("network used")

    monkeypatch.setattr(speechify, "request_json", must_not_run)
    monkeypatch.setattr(speechify, "API_KEY", "")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(speechify.synthesize("hi", VOICE))
    assert exc.value.status_code == 503 and "SPEECHIFY_API_KEY" in exc.value.detail
    with pytest.raises(HTTPException) as exc:
        asyncio.run(speechify.synthesize("hi", "speechify:bad id", key="k"))
    assert exc.value.status_code == 400
    with pytest.raises(HTTPException) as exc:
        asyncio.run(speechify.synthesize("x" * (speechify.MAX_CHARS + 1), VOICE, key="k"))
    assert exc.value.status_code == 422 and "2000 characters" in exc.value.detail


def test_voices_follow_cursors_and_return_the_edge_shape(monkeypatch):
    calls = []

    async def fake_json(key, method, path, json_body=None, timeout=60):
        calls.append((key, path))
        if "cursor=c2" in path:
            return {"voices": [{"id": "henry", "display_name": "Henry", "type": "personal", "gender": "not_specified", "locale": "en-GB", "models": []}], "next_cursor": None, "has_more": False}
        return {"voices": [LISTED, {"display_name": "no id"}], "next_cursor": "c2", "has_more": True}

    monkeypatch.setattr(speechify, "request_json", fake_json)
    listed = asyncio.run(speechify.voices("sk_test"))
    assert [k for k, _ in calls] == ["sk_test", "sk_test"]
    assert calls[0][1].startswith(f"/v1/voices?limit=200&model={speechify.MODEL}") and "cursor=c2" in calls[1][1]
    assert listed == [
        {"name": "Geffen", "shortName": VOICE, "locale": "en-US", "localeName": "en-US · timbre:deep", "gender": "Male", "styleList": [], "provider": "speechify", "category": "shared", "previewUrl": "https://cdn.example/geffen.mp3"},
        {"name": "Henry", "shortName": "speechify:henry", "locale": "en-GB", "localeName": "en-GB", "gender": "", "styleList": [], "provider": "speechify", "category": "personal", "previewUrl": ""},
    ]
    asyncio.run(speechify.voices("sk_test", model="simba-3.2"))
    assert "model=simba-3.2" in calls[-1][1]


def test_sample_uses_preview_or_cloned_download(monkeypatch):
    listed = [
        {"shortName": VOICE, "category": "shared", "previewUrl": "https://cdn.example/geffen.mp3"},
        {"shortName": "speechify:mine", "category": "personal", "previewUrl": ""},
        {"shortName": "speechify:bare", "category": "shared", "previewUrl": ""},
    ]
    fetched = []

    async def fetch_preview(url):
        fetched.append(url)
        return b"ID3preview"

    async def fake_bytes(key, method, path, json_body=None, timeout=120, accept="audio/mpeg"):
        assert (key, method, path, accept) == ("k", "GET", "/v1/voices/mine/sample", "*/*")
        return b"ID3clone", "audio/wav"

    monkeypatch.setattr(speechify, "request_bytes", fake_bytes)
    assert asyncio.run(speechify.sample("k", VOICE, listed, fetch_preview)) == b"ID3preview" and fetched == ["https://cdn.example/geffen.mp3"]
    assert asyncio.run(speechify.sample("k", "speechify:mine", listed, fetch_preview)) == b"ID3clone"
    for voice, words in (("speechify:bare", "no preview clip"), ("speechify:nobody", "No such Speechify voice")):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(speechify.sample("k", voice, listed, fetch_preview))
        assert exc.value.status_code == 404 and words in exc.value.detail
