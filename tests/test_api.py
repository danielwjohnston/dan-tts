"""API tests. Edge TTS and outbound HTTP are stubbed so these run offline."""
import socket

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
    assert client.get("/health").json() == {"status": "ok"}


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
