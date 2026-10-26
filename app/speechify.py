"""Speechify as a voice provider (same rules as worker/src/speechify.js).

Voice ids are "speechify:<voice_id>" so requests route by prefix. Timed speech comes from
POST /v1/audio/speech, whose word-level speech marks (milliseconds) become the same word boundaries
the Edge path returns (100 ns ticks); plain audio comes from POST /v1/audio/stream, which returns the
bytes directly and takes ten times more text. The API key is read from SPEECHIFY_API_KEY on the
server only and sent as a Bearer token; it is never logged or echoed.
"""
from __future__ import annotations

import asyncio
import base64
import json
import math
import os
import re
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

import aiohttp
from fastapi import HTTPException

PREFIX = "speechify:"
ID_RE = re.compile(r"^speechify:[A-Za-z0-9_-]{1,64}\Z")  # \Z: "$" would accept a trailing newline
DEFAULT_MODEL = "simba-3.5"
MAX_CHARS = 2000  # POST /v1/audio/speech: spoken characters per request (SSML tags are not counted)
MAX_STREAM_CHARS = 20000  # POST /v1/audio/stream
DEFAULT_API = "https://api.speechify.ai"  # or a regional host: https://eu.api.speechify.ai, https://us.api.speechify.ai

API_KEY = os.environ.get("SPEECHIFY_API_KEY", "").strip()
MODEL = os.environ.get("SPEECHIFY_MODEL", "").strip() or DEFAULT_MODEL
LANGUAGE = os.environ.get("SPEECHIFY_LANGUAGE", "").strip()  # e.g. fr-FR when the text's language differs from the voice's locale
API = (os.environ.get("SPEECHIFY_API_URL", "").strip() or DEFAULT_API).rstrip("/")

# The markup tags lower() emits for Speechify. Text around them is escaped and the whole input wrapped in
# <speak> before sending, so "&" or "<" typed by a user never breaks the XML. Anything else that looks
# like a tag is spoken as written: hand-written SSML is not passed through, markup tokens are.
_OUR_TAGS = re.compile(r'(<break time="\d+ms"\s*/>|<sub alias="[^"<>]*">[^<>]*</sub>)')
_ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}


def is_speechify_voice(voice: str) -> bool:
    return isinstance(voice, str) and voice.startswith(PREFIX)


def escape_xml(s: str) -> str:
    return re.sub(r"[&<>\"']", lambda m: _ESCAPES[m.group(0)], str(s))


def to_input(text: str) -> str:
    """The request's `input`: plain text as it is, or an SSML document when the text carries our tags."""
    if not _OUR_TAGS.search(text):
        return text
    parts = _OUR_TAGS.split(text)
    return "<speak>" + "".join(part if i % 2 else escape_xml(part) for i, part in enumerate(parts)) + "</speak>"


def _ticks(ms: Any) -> int:
    try:
        value = float(ms)
    except (TypeError, ValueError):
        return 0
    if math.isnan(value) or math.isinf(value):
        return 0
    return math.floor(value * 1e4 + 0.5)  # milliseconds → 100 ns ticks, half-up like the Worker


def error_for(status: int, body: str, retry_after: Optional[str] = None) -> HTTPException:
    """A failed Speechify response as an HTTPException with a plain message. Speechify says to match on error.code."""
    try:
        error = json.loads(body).get("error")
    except Exception:
        error = None
    code = str(error.get("code") or "") if isinstance(error, dict) else ""
    message = str(error.get("message") or "") if isinstance(error, dict) else ""
    suffix = f" ({message})" if message else ""
    if status == 401:
        return HTTPException(status_code=502, detail=f"Speechify rejected the API key{suffix}: check SPEECHIFY_API_KEY on the server")
    if status == 402:
        return HTTPException(status_code=429, detail=f"Speechify credits for this workspace are used up or the plan does not allow this{suffix}. Edge voices still work")
    if code == "model_retired":
        return HTTPException(status_code=502, detail=f"Speechify retired the configured model{suffix}: set SPEECHIFY_MODEL to {DEFAULT_MODEL} on the server")
    if code == "content_policy_violation":
        return HTTPException(status_code=422, detail=f"Speechify declined this text under its content policy{suffix}")
    if status in (400, 422):
        return HTTPException(status_code=422, detail=f"Speechify rejected the request{suffix}")
    if status == 404:
        return HTTPException(status_code=404, detail=f"No such Speechify voice{suffix}")
    if status == 429:
        wait = f"{retry_after} seconds" if retry_after else "a moment"
        return HTTPException(status_code=429, detail=f"Speechify is rate-limiting requests; try again in {wait}")
    return HTTPException(status_code=502, detail=f"Speechify error: HTTP {status}{suffix}")


def _headers(key: str, **extra: str) -> dict:
    return {"Authorization": f"Bearer {key}", "Accept": "application/json", **extra}


def _session(timeout: int, key: str, accept: str) -> aiohttp.ClientSession:
    return aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout), headers=_headers(key, Accept=accept))


async def request_json(key: str, method: str, path: str, json_body: Optional[dict] = None, timeout: int = 60) -> dict:
    """One call to Speechify, parsed as JSON. Failures already carry a plain message."""
    try:
        async with _session(timeout, key, "application/json") as session:
            async with session.request(method, f"{API}{path}", json=json_body) as resp:
                if resp.status != 200:
                    raise error_for(resp.status, await resp.text(), resp.headers.get("Retry-After"))
                try:
                    data = await resp.json(content_type=None)
                except (ValueError, aiohttp.ContentTypeError):
                    data = None
                if not isinstance(data, dict):
                    raise HTTPException(status_code=502, detail="Speechify returned an unreadable response")
                return data
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"Speechify error: {exc}")
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail="Speechify timed out")


async def request_bytes(key: str, method: str, path: str, json_body: Optional[dict] = None, timeout: int = 120, accept: str = "audio/mpeg") -> tuple[bytes, str]:
    """One call to Speechify whose body is a file (streamed audio, a voice sample)."""
    try:
        async with _session(timeout, key, accept) as session:
            async with session.request(method, f"{API}{path}", json=json_body) as resp:
                if resp.status != 200:
                    raise error_for(resp.status, await resp.text(), resp.headers.get("Retry-After"))
                return await resp.read(), resp.headers.get("Content-Type") or ""
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"Speechify error: {exc}")
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail="Speechify timed out")


def _title(s: str) -> str:
    return s[:1].upper() + s[1:] if s else ""


async def voices(key: str, model: str = "") -> list[dict]:
    """The voices the workspace can use with the model, in the same shape as the Edge entries. Listing costs nothing."""
    out: list[dict] = []
    cursor = None
    for _ in range(10):
        path = f"/v1/voices?limit=200&model={quote(model or MODEL)}" + (f"&cursor={quote(cursor)}" if cursor else "")
        data = await request_json(key, "GET", path, timeout=20)
        for v in data.get("voices") or []:
            if not isinstance(v, dict) or not isinstance(v.get("id"), str) or not v["id"]:
                continue
            languages = [lang for m in (v.get("models") or []) if isinstance(m, dict) for lang in (m.get("languages") or []) if isinstance(lang, dict)]
            preview = v.get("preview_audio") or next((lang.get("preview_audio") for lang in languages if lang.get("preview_audio")), "")
            tags = [t for t in (v.get("tags") or []) if isinstance(t, str)][:3]
            out.append({
                "name": v.get("display_name") or v["id"],
                "shortName": f"{PREFIX}{v['id']}",
                "locale": v.get("locale") or "",
                "localeName": " · ".join(x for x in [v.get("locale") or "", *tags] if x),
                "gender": "" if v.get("gender") == "not_specified" else _title(v.get("gender") or ""),
                "styleList": [],
                "provider": "speechify",
                "category": v.get("type") or "",
                "previewUrl": preview if isinstance(preview, str) else "",
            })
        if not data.get("has_more") or not data.get("next_cursor"):
            break
        cursor = data["next_cursor"]
    return out


def marks_to_boundaries(marks: Any) -> list[dict]:
    """Speech marks → word boundaries in 100 ns ticks. Speechify nests them (a sentence or the whole input
    holds `chunks` of words, each with start_time/end_time in milliseconds and the spoken `value`); the
    innermost entries are the words. A streaming response gives a list of such objects."""
    out: list[dict] = []

    def walk(m: Any) -> None:
        if isinstance(m, list):
            for item in m:
                walk(item)
            return
        if not isinstance(m, dict):
            return
        chunks = m.get("chunks")
        if isinstance(chunks, list) and chunks:
            for item in chunks:
                walk(item)
            return
        text = m.get("value").strip() if isinstance(m.get("value"), str) else ""
        if not text:
            return
        offset = _ticks(m.get("start_time"))
        out.append({"offset": offset, "duration": max(0, _ticks(m.get("end_time")) - offset), "text": text})

    walk(marks)
    return out


def _body(text: str, voice: str, model: str, language: str) -> dict:
    out = {"input": to_input(text), "voice_id": voice[len(PREFIX):], "model": model or MODEL, "audio_format": "mp3"}
    if language:
        out["language"] = language
    return out


def _check(text: str, voice: str, key: str, limit: int) -> None:
    if not ID_RE.match(voice):
        raise HTTPException(status_code=400, detail="Invalid voice name")
    if not key:
        raise HTTPException(status_code=503, detail="Speechify voices are not configured on this server (no SPEECHIFY_API_KEY)")
    if len(text) > limit:
        raise HTTPException(status_code=422, detail=f"Text is limited to {limit} characters per request for Speechify voices")


async def synthesize(text: str, voice: str, key: str = "", model: str = "", language: Optional[str] = None) -> tuple[bytes, list[dict]]:
    """Synthesize with word timings (POST /v1/audio/speech)."""
    key = key or API_KEY
    _check(text, voice, key, MAX_CHARS)
    data = await request_json(key, "POST", "/v1/audio/speech", _body(text, voice, model, LANGUAGE if language is None else language))
    if not isinstance(data.get("audio_data"), str) or not data["audio_data"]:
        raise HTTPException(status_code=502, detail="Speechify returned no audio")
    try:
        audio = base64.b64decode(data["audio_data"], validate=True)
    except (ValueError, TypeError):
        raise HTTPException(status_code=502, detail="Speechify returned unreadable audio")
    return audio, marks_to_boundaries(data.get("speech_marks"))


async def stream_mp3(text: str, voice: str, key: str = "", model: str = "", language: Optional[str] = None) -> bytes:
    """Plain audio, no timings (POST /v1/audio/stream): the bytes as Speechify generates them."""
    key = key or API_KEY
    _check(text, voice, key, MAX_STREAM_CHARS)
    audio, _ = await request_bytes(key, "POST", "/v1/audio/stream", _body(text, voice, model, LANGUAGE if language is None else language))
    if not audio:
        raise HTTPException(status_code=502, detail="Speechify returned no audio")
    return audio


async def sample(key: str, voice: str, listed: list[dict], fetch_preview: Callable[[str], Awaitable[bytes]]) -> bytes:
    """The voice's preview clip, for /samples/speechify:<id>. `fetch_preview` is the server's checked
    downloader for a public https URL; a cloned voice without a preview has a sample download instead."""
    found = next((v for v in listed if v.get("shortName") == voice), None)
    if found is None:
        raise HTTPException(status_code=404, detail="No such Speechify voice for this workspace and model")
    if found.get("previewUrl"):
        return await fetch_preview(found["previewUrl"])
    if found.get("category") == "personal":
        audio, _ = await request_bytes(key, "GET", f"/v1/voices/{quote(voice[len(PREFIX):])}/sample", timeout=20, accept="*/*")
        return audio
    raise HTTPException(status_code=404, detail="This Speechify voice has no preview clip")
