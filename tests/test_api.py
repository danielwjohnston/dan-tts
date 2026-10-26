"""API tests. Edge TTS and outbound HTTP are stubbed so these run offline."""
import asyncio
import socket
import time

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app.main as main

FAKE_MP3 = b"ID3fake-mp3-bytes"
# Two words: 0.05s-0.35s and 0.40s-1.25s (offsets/durations in 100ns ticks)
FAKE_BOUNDARIES = [
    {"offset": 500_000, "duration": 3_000_000, "text": "Hello"},
    {"offset": 4_000_000, "duration": 8_500_000, "text": "world"},
]


@pytest.fixture
def client(monkeypatch):
    async def fake_mp3(text, voice):
        return FAKE_MP3

    async def fake_boundaries(text, voice):
        return FAKE_MP3, list(FAKE_BOUNDARIES)

    async def fake_voices():
        return []

    monkeypatch.setattr(main, "synthesize_mp3", fake_mp3)
    monkeypatch.setattr(main, "synthesize_with_boundaries", fake_boundaries)
    monkeypatch.setattr(main, "list_voices", fake_voices)
    with TestClient(main.app) as c:
        yield c


def test_health(client):
    assert client.get("/health").json() == {"status": "ok", "providers": ["edge"]}


def test_synthesize_mp3(client):
    r = client.post("/synthesize", json={"text": "Hello world"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == FAKE_MP3


@pytest.mark.parametrize("text", ["", "   "])
def test_synthesize_rejects_blank_text(client, text):
    assert client.post("/synthesize", json={"text": text}).status_code == 400


def test_synthesize_rejects_overlong_text(client):
    r = client.post("/synthesize", json={"text": "a" * (main.MAX_TEXT_CHARS + 1)})
    assert r.status_code == 422


def test_synthesize_rejects_unknown_format(client):
    assert client.post("/synthesize", json={"text": "hi", "format": "wav"}).status_code == 422


def test_export_json(client):
    r = client.post("/export?format=json", json={"text": "Hello world"})
    assert r.status_code == 200
    meta = r.json()["metadata"]
    assert meta["words"] == 2
    assert meta["duration_ms"] == 1250


def test_export_webvtt(client):
    r = client.post("/export?format=webvtt", json={"text": "Hello world"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/vtt")
    assert r.text.splitlines()[:6] == [
        "WEBVTT", "",
        "00:00:00.050 --> 00:00:00.350", "Hello", "",
        "00:00:00.400 --> 00:00:01.250",
    ]


def test_export_srt(client):
    r = client.post("/export?format=srt", json={"text": "Hello world"})
    assert r.status_code == 200
    assert 'filename="captions.srt"' in r.headers["content-disposition"]
    assert r.text.splitlines() == [
        "1", "00:00:00,050 --> 00:00:00,350", "Hello", "",
        "2", "00:00:00,400 --> 00:00:01,250", "world",
    ]


def test_export_rejects_unknown_format(client):
    assert client.post("/export?format=docx", json={"text": "hi"}).status_code == 400


def test_timestamp_handles_hours():
    assert main._timestamp(3_723_004, ",") == "01:02:03,004"


@pytest.mark.parametrize("voice", ["..evil", "en-US-Aria", "x" * 50])
def test_sample_rejects_bad_voice_names(client, voice):
    assert client.get(f"/samples/{voice}").status_code == 400


# ---- /extract_text ----

def _resolve_to(monkeypatch, ip):
    async def fake_getaddrinfo(self, host, port, *a, **kw):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]
    monkeypatch.setattr("asyncio.base_events.BaseEventLoop.getaddrinfo", fake_getaddrinfo)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1"])
def test_extract_blocks_private_hosts(client, monkeypatch, ip):
    _resolve_to(monkeypatch, ip)
    r = client.post("/extract_text", json={"url": "https://internal.example"})
    assert r.status_code == 400
    assert "not allowed" in r.json()["detail"]


def test_extract_rejects_other_schemes(client):
    assert client.post("/extract_text", json={"url": "ftp://example.com"}).status_code == 400


def test_extract_bare_domain_tries_https_then_http(client, monkeypatch):
    tried = []

    async def fake_fetch(url):
        tried.append(url)
        if url.startswith("https://"):
            raise HTTPException(status_code=502, detail="TLS failed")
        return "<html><body><main>" + "word " * 20 + "</main></body></html>"

    monkeypatch.setattr(main, "_fetch_html", fake_fetch)
    r = client.post("/extract_text", json={"url": "example.com"})
    assert r.status_code == 200
    assert tried == ["https://example.com", "http://example.com"]


def test_extract_falls_back_to_meta_description(client, monkeypatch):
    async def fake_fetch(url):
        return ('<html><head><title>Digg</title>'
                '<meta property="og:description" content="News before it trends">'
                '</head><body><div id="root"></div></body></html>')

    monkeypatch.setattr(main, "_fetch_html", fake_fetch)
    r = client.post("/extract_text", json={"url": "digg.com"})
    assert r.status_code == 200
    assert r.json()["text"] == "Digg\n\nNews before it trends"


def test_extract_js_only_page_returns_422(client, monkeypatch):
    async def fake_fetch(url):
        return "<html><body><div id='root'></div></body></html>"

    monkeypatch.setattr(main, "_fetch_html", fake_fetch)
    assert client.post("/extract_text", json={"url": "spa.example"}).status_code == 422


def test_extract_skips_sidebar_and_header_without_main(client, monkeypatch):
    page = (
        "<html><body>"
        "<div class='site-header'><p>Wikisource Log in Donate</p></div>"
        "<div class='sidebar-menu'><p>Navigation links for the sidebar here</p></div>"
        "<div id='content'><p>" + "The story begins on a dark and stormy night. " * 4 + "</p>"
        "<p>It continues the next morning in the same town.</p></div>"
        "</body></html>"
    )

    async def fake_fetch(url):
        return page

    monkeypatch.setattr(main, "_fetch_html", fake_fetch)
    text = client.post("/extract_text", json={"url": "book.example"}).json()["text"]
    assert "dark and stormy night" in text
    assert "next morning" in text
    assert "Log in" not in text
    assert "Navigation links" not in text


# ---- /extract_text: the same rules as the Cloudflare Worker (worker/test/extract.test.js) ----

def _extract(client, monkeypatch, page):
    async def fake_fetch(url):
        return page

    monkeypatch.setattr(main, "_fetch_html", fake_fetch)
    r = client.post("/extract_text", json={"url": "https://book.example/"})
    assert r.status_code == 200, r.text
    return r.json()


STORY = ("<p>" + "The story begins on a dark and stormy night. " * 4 + "</p>"
         "<p>It continues the next morning in the same town.</p>")


def test_extract_reads_main_and_drops_code_and_chrome(client, monkeypatch):
    page = ("<html><head><title>Example  Page</title></head><body><header><p>Site name Log in</p></header>"
            "<nav><a href='/'>Home</a></nav><main><h1>Title</h1>" + STORY +
            "<script>var x = '<p>not text</p>';</script><style>p { color: red }</style></main>"
            "<footer><p>Copyright</p></footer></body></html>")
    data = _extract(client, monkeypatch, page)
    assert data["title"] == "Example Page"
    assert data["text"].startswith("Title\n\nThe story begins")
    for bad in ("Log in", "Home", "not text", "color", "Copyright"):
        assert bad not in data["text"]


def test_extract_skips_mediawiki_chrome_hidden_elements_and_buttons(client, monkeypatch):
    page = ("<html><body><main><div id='siteSub' class='noprint'>From Wikisource</div>"
            "<div class='ws-header wst-header ws-noexport noprint'><div>←</div><a href='/toc'>Contents</a><span>Chapter 2</span><div>→</div></div>"
            "<span role='button' class='oo-ui-buttonElement-button'>Download</span>"
            "<div class='hatnote' role='note'>For other uses, see Library (disambiguation).</div>"
            "<p hidden>Hidden paragraph text</p><p aria-hidden='true'>Decorative text</p><p style='display:none'>Invisible text</p>"
            "<span class='sr-only'>Skip to content</span>"
            "<h2>Chapter one <span class='mw-editsection'>[edit]</span></h2>" + STORY +
            "<div id='catlinks' class='catlinks'><a href='#'>Category: Novels</a></div></main></body></html>")
    text = _extract(client, monkeypatch, page)["text"]
    assert text.startswith("Chapter one\n\nThe story begins")
    for bad in ("Wikisource", "Contents", "→", "Download", "other uses", "Hidden", "Decorative", "Invisible", "Skip", "edit", "Category"):
        assert bad not in text, bad


def test_extract_paragraphs_and_inline_text(client, monkeypatch):
    page = ("<html><body><div><p>Hello <b>bold</b> and <i>italic</i>, with a<br>line break.</p>"
            "<h2>Heading</h2><ul><li>First item</li><li>Second item</li></ul>"
            "<p>Spaced&nbsp;words &amp; entities: &ldquo;quoted&rdquo; &eacute; &#8212;</p></div></body></html>")
    assert _extract(client, monkeypatch, page)["text"] == (
        "Hello bold and italic, with a\nline break.\n\nHeading\n\nFirst item\n\nSecond item\n\nSpaced words & entities: “quoted” é —")


def test_extract_reads_first_article_when_there_is_no_main(client, monkeypatch):
    page = ("<html><body><div class='promo'><p>Buy now</p></div><article><p>One two three four five six.</p></article>"
            "<article><p>Second article text here.</p></article></body></html>")
    assert _extract(client, monkeypatch, page)["text"] == "One two three four five six."


# ---- ElevenLabs provider ----

ELEVEN_VOICE = "eleven:21m00Tcm4TlvDq8ikWAM"
# "Hi there" spoken over 0.00s-0.95s
ALIGNMENT = {
    "characters": list("Hi there"),
    "character_start_times_seconds": [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
    "character_end_times_seconds": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.95],
}


def test_alignment_to_boundaries_groups_words_in_ticks():
    assert main._alignment_to_boundaries(ALIGNMENT) == [
        {"offset": 0, "duration": 2_000_000, "text": "Hi"},
        {"offset": 3_000_000, "duration": 6_500_000, "text": "there"},
    ]
    assert main._alignment_to_boundaries({}) == []
    assert main._alignment_to_boundaries({"characters": [" ", "\n"]}) == []


@pytest.mark.parametrize("status, body, expected_status, words", [
    (401, '{"detail": {"status": "invalid_api_key"}}', 502, "rejected the API key"),
    (401, '{"detail": {"status": "quota_exceeded"}}', 429, "credits for this month are used up"),
    (402, "{}", 429, "credits"),
    (400, '{"detail": {"status": "max_character_limit_exceeded"}}', 422, "too long"),
    (429, '{"detail": "slow down"}', 429, "rate-limiting"),
    (500, "not json", 502, "HTTP 500"),
])
def test_eleven_errors_are_plain_language(status, body, expected_status, words):
    exc = main._eleven_error(status, body)
    assert exc.status_code == expected_status
    assert words in exc.detail


def test_eleven_synthesize_posts_with_timestamps(monkeypatch):
    seen = {}

    async def fake_request(method, path, json_body=None, timeout=60):
        seen.update(method=method, path=path, body=json_body)
        return {"audio_base64": "SUQzZWxldmVu", "alignment": ALIGNMENT}  # "ID3eleven"

    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    monkeypatch.setattr(main, "_eleven_request", fake_request)
    audio, boundaries = asyncio.run(main._eleven_synthesize("Hi there", ELEVEN_VOICE))
    assert seen["method"] == "POST"
    assert seen["path"] == "/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/with-timestamps?output_format=mp3_44100_128"
    assert seen["body"] == {"text": "Hi there", "model_id": main.ELEVENLABS_MODEL}
    assert audio == b"ID3eleven"
    assert [b["text"] for b in boundaries] == ["Hi", "there"]


def test_eleven_synthesize_validates_before_network(monkeypatch):
    async def must_not_run(*args, **kwargs):
        raise AssertionError("no network call expected")

    monkeypatch.setattr(main, "_eleven_request", must_not_run)
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "")
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_synthesize("hi", ELEVEN_VOICE))
    assert e.value.status_code == 503
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_synthesize("hi", "eleven:bad"))
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_synthesize("x" * (main.ELEVEN_MAX_CHARS + 1), ELEVEN_VOICE))
    assert e.value.status_code == 422


def test_eleven_voices_route_by_prefix(monkeypatch):
    calls = []

    async def fake_eleven(text, voice):
        calls.append(voice)
        return b"ID3eleven", [{"offset": 0, "duration": 1, "text": "hi"}]

    monkeypatch.setattr(main, "_eleven_synthesize", fake_eleven)
    assert asyncio.run(main.synthesize_mp3("hi", ELEVEN_VOICE)) == b"ID3eleven"
    assert asyncio.run(main.synthesize_with_boundaries("hi", ELEVEN_VOICE))[0] == b"ID3eleven"
    assert calls == [ELEVEN_VOICE, ELEVEN_VOICE]


def test_health_lists_elevenlabs_when_key_is_set(client, monkeypatch):
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    assert client.get("/health").json() == {"status": "ok", "providers": ["edge", "elevenlabs"]}


def test_voices_merge_edge_and_elevenlabs(monkeypatch):
    async def fake_edge_list():
        return [
            {"Name": "Aria", "ShortName": "en-US-AriaNeural", "Locale": "en-US", "LocaleName": "English (United States)", "Gender": "Female", "StyleList": ["chat"]},
            {"Name": "Katja", "ShortName": "de-DE-KatjaNeural", "Locale": "de-DE", "LocaleName": "German", "Gender": "Female"},
        ]

    async def fake_eleven_voices():
        return [{"name": "Adam", "shortName": "eleven:aaaaaaaaaaaa", "provider": "elevenlabs"}]

    monkeypatch.setattr(main.edge_tts, "list_voices", fake_edge_list)
    monkeypatch.setattr(main, "_eleven_voices", fake_eleven_voices)
    monkeypatch.setattr(main, "_voice_cache", None)
    monkeypatch.setattr(main, "_eleven_voice_cache", None)
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    with TestClient(main.app) as c:
        voices = c.get("/voices").json()
    assert [(v["shortName"], v["provider"], v["sampleUrl"]) for v in voices] == [
        ("en-US-AriaNeural", "edge", "/samples/en-US-AriaNeural"),
        ("eleven:aaaaaaaaaaaa", "elevenlabs", "/samples/eleven:aaaaaaaaaaaa"),
    ]


def test_voices_keep_edge_list_when_elevenlabs_fails(monkeypatch):
    async def fake_edge_list():
        return [{"Name": "Aria", "ShortName": "en-US-AriaNeural", "Locale": "en-US"}]

    attempts = []

    async def failing_eleven_voices():
        attempts.append(1)
        raise HTTPException(status_code=502, detail="ElevenLabs rejected the API key")

    monkeypatch.setattr(main.edge_tts, "list_voices", fake_edge_list)
    monkeypatch.setattr(main, "_eleven_voices", failing_eleven_voices)
    monkeypatch.setattr(main, "_voice_cache", None)
    monkeypatch.setattr(main, "_eleven_voice_cache", None)
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    with TestClient(main.app) as c:
        assert [v["shortName"] for v in c.get("/voices").json()] == ["en-US-AriaNeural"]
        c.get("/voices")
    assert len(attempts) >= 2  # a failure is not cached


def test_eleven_sample_serves_preview_clip(client, monkeypatch, tmp_path):
    async def fake_voices():
        return [{"shortName": ELEVEN_VOICE, "previewUrl": "https://cdn.example/a.mp3"}, {"shortName": "eleven:cccccccccccc", "previewUrl": ""}]

    async def fake_bytes(url):
        assert url == "https://cdn.example/a.mp3"
        return b"ID3preview"

    monkeypatch.setattr(main, "SAMPLES_DIR", tmp_path)
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    monkeypatch.setattr(main, "_eleven_voice_cache", asyncio.run(fake_voices()))
    monkeypatch.setattr(main, "_eleven_fetch_bytes", fake_bytes)
    r = client.get(f"/samples/{ELEVEN_VOICE}")
    assert r.status_code == 200
    assert r.content == b"ID3preview"
    assert (tmp_path / "eleven-21m00Tcm4TlvDq8ikWAM.mp3").exists()
    assert client.get("/samples/eleven:cccccccccccc").status_code == 404
    assert client.get("/samples/eleven:zzzzzzzzzzzz").status_code == 404
    assert client.get("/samples/eleven:bad").status_code == 400


def test_eleven_id_rejects_trailing_newline_and_checks_id_before_key(monkeypatch):
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "")
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_synthesize("hi", "eleven:bad"))
    assert e.value.status_code == 400  # same order as the Worker: id first, then key
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_synthesize("hi", ELEVEN_VOICE + "\n"))
    assert e.value.status_code == 400


def test_alignment_matches_worker_on_odd_whitespace_and_rounding():
    def words(chars):
        n = len(chars)
        al = {"characters": chars, "character_start_times_seconds": [i / 10 for i in range(n)], "character_end_times_seconds": [(i + 1) / 10 for i in range(n)]}
        return [b["text"] for b in main._alignment_to_boundaries(al)]

    assert words(["a", "﻿", "b", " ", "c"]) == ["a", "b", "c"]
    assert words(["a", "\x85", "b", " ", "c"]) == ["a\x85b", "c"]
    assert words(["Hello ", "world"]) == ["Hello world"]  # never dropped, same as the Worker
    assert words(["Hi", "  ", "there"]) == ["Hi", "there"]
    b = main._alignment_to_boundaries({"characters": ["a"], "character_start_times_seconds": [0.00000005], "character_end_times_seconds": [0.00000025]})
    assert b == [{"offset": 1, "duration": 2, "text": "a"}]


def test_eleven_rejected_key_keeps_provider_message():
    exc = main._eleven_error(401, '{"detail": {"status": "invalid_api_key", "message": "Invalid API key"}}')
    assert exc.status_code == 502
    assert "(Invalid API key)" in exc.detail


def test_eleven_synthesize_rejects_unreadable_audio(monkeypatch):
    async def fake_request(method, path, json_body=None, timeout=60):
        return {"audio_base64": "%%%", "alignment": {}}

    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    monkeypatch.setattr(main, "_eleven_request", fake_request)
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_synthesize("hi", ELEVEN_VOICE))
    assert e.value.status_code == 502


def test_voices_survive_a_malformed_elevenlabs_listing(monkeypatch):
    async def fake_edge_list():
        return [{"Name": "Aria", "ShortName": "en-US-AriaNeural", "Locale": "en-US"}]

    async def broken_listing():
        raise TypeError("'NoneType' object is not iterable")

    monkeypatch.setattr(main.edge_tts, "list_voices", fake_edge_list)
    monkeypatch.setattr(main, "_eleven_voices", broken_listing)
    monkeypatch.setattr(main, "_voice_cache", None)
    monkeypatch.setattr(main, "_eleven_voice_cache", None)
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    with TestClient(main.app) as c:
        assert [v["shortName"] for v in c.get("/voices").json()] == ["en-US-AriaNeural"]


def test_voices_refresh_clears_the_elevenlabs_cache(monkeypatch):
    async def fake_edge_list():
        return [{"Name": "Aria", "ShortName": "en-US-AriaNeural", "Locale": "en-US"}]

    calls = []

    async def fake_eleven_voices():
        calls.append(1)
        return [{"name": "Adam", "shortName": "eleven:aaaaaaaaaaaa", "provider": "elevenlabs"}]

    monkeypatch.setattr(main.edge_tts, "list_voices", fake_edge_list)
    monkeypatch.setattr(main, "_eleven_voices", fake_eleven_voices)
    monkeypatch.setattr(main, "_voice_cache", None)
    monkeypatch.setattr(main, "_eleven_voice_cache", None)
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    with TestClient(main.app) as c:
        c.get("/voices")
        c.get("/voices")
        assert len(calls) == 1
        c.get("/voices?refresh=1")
        assert len(calls) == 2


def test_eleven_sample_status_codes_match_the_worker(client, monkeypatch, tmp_path):
    monkeypatch.setattr(main, "SAMPLES_DIR", tmp_path)
    monkeypatch.setattr(main, "_eleven_voice_cache", None)
    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "")
    assert client.get(f"/samples/{ELEVEN_VOICE}").status_code == 503  # no key

    async def rejected():
        raise HTTPException(status_code=502, detail="ElevenLabs rejected the API key: check ELEVENLABS_API_KEY on the server")

    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    monkeypatch.setattr(main, "_eleven_voices", rejected)
    r = client.get(f"/samples/{ELEVEN_VOICE}")
    assert r.status_code == 502  # the listing's real error, not a 404
    assert "rejected the API key" in r.json()["detail"]


def test_eleven_preview_download_is_guarded(monkeypatch):
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_fetch_bytes("http://169.254.169.254/latest/meta-data"))
    assert e.value.status_code == 502 and "https" in e.value.detail

    async def private_host(url):
        raise HTTPException(status_code=400, detail="URL host is not allowed")

    monkeypatch.setattr(main, "_assert_public_host", private_host)
    with pytest.raises(HTTPException) as e:
        asyncio.run(main._eleven_fetch_bytes("https://10.0.0.1/clip.mp3"))
    assert e.value.status_code == 502


def test_usage_reports_edge_unlimited_and_elevenlabs_credits(client, monkeypatch):
    assert client.get("/usage").json() == {"edge": {"unlimited": True}}

    async def fake_request(method, path, json_body=None, timeout=60):
        assert (method, path) == ("GET", "/v1/user/subscription")
        return {"tier": "free", "character_count": 150, "character_limit": 10000, "next_character_count_reset_unix": 1762128000}

    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    monkeypatch.setattr(main, "_eleven_request", fake_request)
    monkeypatch.setattr(main, "_eleven_usage_cache", None)
    expected = {"provider": "elevenlabs", "tier": "free", "used": 150, "limit": 10000, "remaining": 9850, "resetsAt": "2025-11-03T00:00:00Z"}
    assert client.get("/usage").json() == {"edge": {"unlimited": True}, "elevenlabs": expected}

    # Served from the one-minute cache: the provider is not asked again, whatever the query string says
    async def must_not_run(*a, **k):
        raise AssertionError("cached answer expected")

    monkeypatch.setattr(main, "_eleven_request", must_not_run)
    assert client.get("/usage").json()["elevenlabs"] == expected
    assert client.get("/usage?refresh=1").json()["elevenlabs"] == expected
    # Once expired, the provider is asked again
    expires_at, cached = main._eleven_usage_cache
    monkeypatch.setattr(main, "_eleven_usage_cache", (expires_at - 120, cached))
    r = client.get("/usage")
    assert r.status_code == 200 and "error" in r.json()["elevenlabs"]


def test_usage_coerces_odd_values_like_the_worker(monkeypatch):
    async def fake_request(method, path, json_body=None, timeout=60):
        return {"character_count": "150.7", "character_limit": 10000.2, "next_character_count_reset_unix": "1762128000", "tier": None}

    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    monkeypatch.setattr(main, "_eleven_request", fake_request)
    assert asyncio.run(main._eleven_usage()) == {"provider": "elevenlabs", "tier": "", "used": 150, "limit": 10000, "remaining": 9850, "resetsAt": "2025-11-03T00:00:00Z"}
    assert main._num("abc") == 0 and main._num([1]) == 0 and main._num(None) == 0


def test_usage_reports_a_failed_lookup_without_failing(client, monkeypatch):
    async def rejected(method, path, json_body=None, timeout=60):
        raise main._eleven_error(401, '{"detail": {"status": "invalid_api_key"}}')

    monkeypatch.setattr(main, "ELEVENLABS_API_KEY", "secret")
    monkeypatch.setattr(main, "_eleven_request", rejected)
    monkeypatch.setattr(main, "_eleven_usage_cache", None)
    r = client.get("/usage")
    assert r.status_code == 200
    assert "rejected the API key" in r.json()["elevenlabs"]["error"]
    # The failure is kept briefly (15 s), like the Worker, so an outage is not amplified
    expires_at, cached = main._eleven_usage_cache
    assert cached == r.json()["elevenlabs"]
    assert 0 < expires_at - time.monotonic() <= main.USAGE_TTL_ERROR  # loop.time() is the monotonic clock


# ---- Speechify provider through the routes ----
SPEECHIFY_VOICE = "speechify:geffen_32"


def test_speechify_provider_is_listed_only_with_a_key(client, monkeypatch):
    monkeypatch.setattr(main.speechify, "API_KEY", "")
    assert "speechify" not in client.get("/health").json()["providers"]
    monkeypatch.setattr(main.speechify, "API_KEY", "sk_test")
    assert client.get("/health").json()["providers"][-1] == "speechify"


def test_speechify_voices_route_by_prefix(monkeypatch):
    """The real synthesizers (not the fixture's fakes) send speechify: voices to the provider module."""
    seen = []

    async def fake_timed(text, voice, key="", model="", language=None):
        seen.append(("timed", text, voice))
        return b"ID3speechify", [{"offset": 0, "duration": 2_000_000, "text": "Hi"}]

    async def fake_stream(text, voice, key="", model="", language=None):
        seen.append(("stream", text, voice))
        return b"ID3stream"

    monkeypatch.setattr(main.speechify, "synthesize", fake_timed)
    monkeypatch.setattr(main.speechify, "stream_mp3", fake_stream)
    audio, boundaries = asyncio.run(main.synthesize_with_boundaries("Hi", SPEECHIFY_VOICE))
    assert (audio, boundaries) == (b"ID3speechify", [{"offset": 0, "duration": 2_000_000, "text": "Hi"}])
    assert asyncio.run(main.synthesize_mp3("Hi", SPEECHIFY_VOICE)) == b"ID3stream"
    assert seen == [("timed", "Hi", SPEECHIFY_VOICE), ("stream", "Hi", SPEECHIFY_VOICE)]


def test_speechify_samples_and_bad_ids_fail_clearly(client, monkeypatch):
    monkeypatch.setattr(main.speechify, "API_KEY", "")
    res = client.get(f"/samples/{SPEECHIFY_VOICE}")
    assert res.status_code == 503 and "SPEECHIFY_API_KEY" in res.json()["detail"]
    assert client.get("/samples/speechify:bad%20id").status_code == 400
