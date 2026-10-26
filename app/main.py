"""
Dan's TTS Project (FastAPI)
- Uses Microsoft Edge TTS voices (no API key) via edge-tts
- Returns MP3 directly; transcodes to m4a/ogg/flac with ffmpeg
"""

import asyncio
import base64
import ipaddress
import json
import math
import os
import re
import socket
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional
from urllib.parse import quote, urljoin, urlparse

import aiohttp
import edge_tts
from bs4 import BeautifulSoup
from bs4.element import NavigableString, PreformattedString, Tag
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from starlette.responses import FileResponse, Response

SUPPORTED_FORMATS = Literal["mp3", "m4a", "ogg", "flac"]
DEFAULT_VOICE = "en-US-AriaNeural"
BASE_DIR = Path(__file__).resolve().parent.parent
TESTER_HTML = BASE_DIR / "tester.html"
SAMPLE_TEXT = "This is a sample of the selected voice."
SAMPLES_DIR = BASE_DIR / "samples"
MAX_TEXT_CHARS = 20000
MAX_FETCH_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 5
VOICE_NAME_RE = re.compile(r"^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$")  # Edge voices

# ElevenLabs as a second voice provider (same rules as worker/src/elevenlabs.js). Voice ids are
# "eleven:<voice_id>" so requests route by prefix; the key lives on the server only.
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "").strip()
ELEVENLABS_MODEL = os.environ.get("ELEVENLABS_MODEL", "eleven_multilingual_v2")
ELEVEN_PREFIX = "eleven:"
ELEVEN_ID_RE = re.compile(r"^eleven:[A-Za-z0-9_-]{8,64}\Z")  # \Z: "$" would accept a trailing newline
ELEVEN_MAX_CHARS = 5000  # per request; the tester splits long text into paragraphs anyway
ELEVEN_API = "https://api.elevenlabs.io"

_voice_cache: Optional[List[Dict]] = None
_eleven_voice_cache: Optional[List[Dict]] = None

app = FastAPI(title="Dan's TTS Project", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class PermissionsPolicyMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["Permissions-Policy"] = "clipboard-read=(self), clipboard-write=(self)"
        return response


app.add_middleware(PermissionsPolicyMiddleware)

# Mount static files for standalone player
app.mount("/static", StaticFiles(directory="static"), name="static")


class SynthesisRequest(BaseModel):
    text: str = Field(..., max_length=MAX_TEXT_CHARS, description="Plain text or SSML to synthesize")
    voice: str = Field(DEFAULT_VOICE, description="Microsoft Edge voice name")
    format: SUPPORTED_FORMATS = Field(
        "mp3", description="Output format: mp3 (direct), m4a, ogg, or flac"
    )


class ExtractTextRequest(BaseModel):
    url: str = Field(..., description="URL to fetch and extract text from")


def _valid_voice(voice: str) -> bool:
    return bool(VOICE_NAME_RE.match(voice) or ELEVEN_ID_RE.match(voice))


def _providers() -> list[str]:
    return ["edge"] + (["elevenlabs"] if ELEVENLABS_API_KEY else [])


def _eleven_error(status: int, body: str) -> HTTPException:
    """A failed ElevenLabs response as an HTTPException with a plain message."""
    try:
        detail = json.loads(body).get("detail")
    except Exception:
        detail = None
    code = detail.get("status") if isinstance(detail, dict) else None
    message = detail.get("message") if isinstance(detail, dict) else (detail if isinstance(detail, str) else "")
    if status == 401 and code != "quota_exceeded":
        return HTTPException(status_code=502, detail=f"ElevenLabs rejected the API key{f' ({message})' if message else ''}: check ELEVENLABS_API_KEY on the server")
    if code == "quota_exceeded" or status == 402:
        return HTTPException(status_code=429, detail="ElevenLabs credits for this month are used up. Edge voices still work; credits reset monthly")
    if code == "max_character_limit_exceeded":
        return HTTPException(status_code=422, detail=f"Text is too long for ElevenLabs in one request (limit about {ELEVEN_MAX_CHARS} characters)")
    if status == 429:
        return HTTPException(status_code=429, detail="ElevenLabs is rate-limiting requests; try again in a moment")
    return HTTPException(status_code=502, detail=f"ElevenLabs error: HTTP {status}" + (f" ({message})" if message else ""))


async def _eleven_request(method: str, path: str, json_body: Optional[dict] = None, timeout: int = 60) -> dict:
    """One call to ElevenLabs, parsed as JSON."""
    headers = {"xi-api-key": ELEVENLABS_API_KEY, "Accept": "application/json"}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout), headers=headers) as session:
            async with session.request(method, f"{ELEVEN_API}{path}", json=json_body) as resp:
                if resp.status != 200:
                    raise _eleven_error(resp.status, await resp.text())
                try:
                    data = await resp.json(content_type=None)
                except (ValueError, aiohttp.ContentTypeError):
                    data = None
                if not isinstance(data, dict):
                    raise HTTPException(status_code=502, detail="ElevenLabs returned an unreadable response")
                return data
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"ElevenLabs error: {exc}")
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail="ElevenLabs timed out")


async def _eleven_fetch_bytes(url: str) -> bytes:
    """Download a preview clip. The URL comes from the provider's listing, so it gets the same public-host
    check as Load from URL, must be https, may not redirect, and is capped in size."""
    if urlparse(url).scheme != "https":
        raise HTTPException(status_code=502, detail="ElevenLabs preview URL is not https")
    try:
        await _assert_public_host(url)
    except HTTPException:
        raise HTTPException(status_code=502, detail="ElevenLabs preview URL points at a host this server will not fetch")
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
            async with session.get(url, allow_redirects=False) as resp:
                if resp.status != 200:
                    raise HTTPException(status_code=502, detail=f"ElevenLabs preview failed: HTTP {resp.status}")
                body = await resp.content.read(MAX_FETCH_BYTES + 1)
                if len(body) > MAX_FETCH_BYTES:
                    raise HTTPException(status_code=502, detail="ElevenLabs preview clip is too large")
                return body
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"ElevenLabs preview failed: {exc}")
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail="ElevenLabs preview timed out")


def _title(s: str) -> str:
    return s[:1].upper() + s[1:] if s else ""


async def _eleven_voices() -> list[dict]:
    """The account's voices, in the same shape as the Edge entries. Listing costs no credits."""
    out: list[dict] = []
    token = None
    for _ in range(10):
        data = await _eleven_request("GET", "/v2/voices?page_size=100" + (f"&next_page_token={quote(token)}" if token else ""), timeout=20)
        for v in data.get("voices") or []:
            labels = v.get("labels") or {}
            out.append({
                "name": v.get("name") or v.get("voice_id"),
                "shortName": f"{ELEVEN_PREFIX}{v.get('voice_id')}",
                "locale": labels.get("language") or "",
                "localeName": " · ".join(_title(x) for x in (labels.get("accent"), labels.get("age"), labels.get("use_case")) if x),
                "gender": _title(labels.get("gender") or ""),
                "styleList": [],
                "provider": "elevenlabs",
                "category": v.get("category") or "",
                "previewUrl": v.get("preview_url") or "",
            })
        if not data.get("has_more") or not data.get("next_page_token"):
            break
        token = data["next_page_token"]
    return out


# An alignment entry that is only whitespace separates words. Same explicit class as worker/src/elevenlabs.js
# (not str.isspace(), which disagrees with JavaScript's \s on a few code points), so both servers split alike.
_WHITESPACE_ENTRY = re.compile("[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+")


def _ticks(seconds: float) -> int:
    return math.floor(seconds * 1e7 + 0.5)  # half-up, like the Worker's Math.round-style rounding


def _alignment_to_boundaries(alignment: dict) -> list[dict]:
    """Per-character times → one boundary per whitespace-separated word, in 100 ns ticks."""
    chars = alignment.get("characters") or []
    starts = alignment.get("character_start_times_seconds") or []
    ends = alignment.get("character_end_times_seconds") or []

    def is_space(entry) -> bool:
        return bool(_WHITESPACE_ENTRY.fullmatch(str(entry)))

    out = []
    i = 0
    while i < len(chars):
        while i < len(chars) and is_space(chars[i]):
            i += 1
        if i >= len(chars):
            break
        first = i
        text = ""
        while i < len(chars) and not is_space(chars[i]):
            text += str(chars[i])
            i += 1
        start_s = starts[first] if first < len(starts) else 0
        offset = _ticks(start_s or 0)
        end_s = ends[i - 1] if i - 1 < len(ends) and ends[i - 1] is not None else start_s
        out.append({"offset": offset, "duration": max(0, _ticks(end_s or 0) - offset), "text": text})
    return out


_eleven_usage_cache: Optional[tuple[float, dict]] = None


async def _eleven_usage() -> dict:
    """This month's credit use. The free plan counts characters, so credits and characters are the same number."""
    s = await _eleven_request("GET", "/v1/user/subscription", timeout=15)
    used = int(s.get("character_count") or 0)
    limit = int(s.get("character_limit") or 0)
    reset = s.get("next_character_count_reset_unix")
    return {
        "provider": "elevenlabs",
        "tier": s.get("tier") or "",
        "used": used,
        "limit": limit,
        "remaining": max(0, limit - used),
        "resetsAt": datetime.fromtimestamp(reset, tz=timezone.utc).isoformat().replace("+00:00", "Z") if reset else None,
    }


async def _usage() -> dict:
    """What each provider costs right now; a failed ElevenLabs lookup is reported, not raised. Cached for a minute."""
    global _eleven_usage_cache
    out: dict = {"edge": {"unlimited": True}}
    if not ELEVENLABS_API_KEY:
        return out
    now = asyncio.get_running_loop().time()
    if _eleven_usage_cache and now - _eleven_usage_cache[0] < 60:
        out["elevenlabs"] = _eleven_usage_cache[1]
        return out
    try:
        out["elevenlabs"] = await _eleven_usage()
        _eleven_usage_cache = (now, out["elevenlabs"])
    except HTTPException as exc:
        out["elevenlabs"] = {"error": exc.detail}
    except Exception:
        out["elevenlabs"] = {"error": "ElevenLabs usage unavailable"}
    return out


async def _eleven_synthesize(text: str, voice: str) -> tuple[bytes, list[dict]]:
    if not ELEVEN_ID_RE.match(voice):
        raise HTTPException(status_code=400, detail="Invalid voice name")
    if not ELEVENLABS_API_KEY:
        raise HTTPException(status_code=503, detail="ElevenLabs voices are not configured on this server (no ELEVENLABS_API_KEY)")
    if len(text) > ELEVEN_MAX_CHARS:
        raise HTTPException(status_code=422, detail=f"Text is limited to {ELEVEN_MAX_CHARS} characters per request for ElevenLabs voices")
    voice_id = voice[len(ELEVEN_PREFIX):]
    data = await _eleven_request(
        "POST", f"/v1/text-to-speech/{quote(voice_id)}/with-timestamps?output_format=mp3_44100_128",
        json_body={"text": text, "model_id": ELEVENLABS_MODEL},
    )
    if not isinstance(data.get("audio_base64"), str) or not data["audio_base64"]:
        raise HTTPException(status_code=502, detail="ElevenLabs returned no audio")
    try:
        audio = base64.b64decode(data["audio_base64"], validate=True)
    except (ValueError, TypeError):
        raise HTTPException(status_code=502, detail="ElevenLabs returned unreadable audio")
    alignment = data.get("alignment") or data.get("normalized_alignment") or {}
    return audio, _alignment_to_boundaries(alignment if isinstance(alignment, dict) else {})


async def synthesize_mp3(text: str, voice: str) -> bytes:
    if voice.startswith(ELEVEN_PREFIX):
        audio, _ = await _eleven_synthesize(text, voice)
        return audio
    communicator = edge_tts.Communicate(text, voice=voice)
    audio_chunks = []
    async for chunk in communicator.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
    if not audio_chunks:
        raise HTTPException(status_code=500, detail="No audio returned from TTS")
    return b"".join(audio_chunks)


async def synthesize_with_boundaries(text: str, voice: str):
    if voice.startswith(ELEVEN_PREFIX):
        return await _eleven_synthesize(text, voice)
    communicator = edge_tts.Communicate(text, voice=voice, boundary="WordBoundary")
    audio_chunks = []
    boundaries = []
    async for chunk in communicator.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            boundaries.append({
                "offset": chunk["offset"],
                "duration": chunk["duration"],
                "text": chunk["text"],
            })
    if not audio_chunks:
        raise HTTPException(status_code=500, detail="No audio returned from TTS")
    return b"".join(audio_chunks), boundaries


def _transcode(src_bytes: bytes, target: str) -> bytes:
    codecs = {
        "m4a": ["-c:a", "aac"],
        "ogg": ["-c:a", "libopus"],
        "flac": ["-c:a", "flac"],
    }
    if target not in codecs:
        raise ValueError(f"Unsupported format: {target}")

    with tempfile.NamedTemporaryFile(suffix=".mp3") as src_file, tempfile.NamedTemporaryFile(
        suffix=f".{target}"
    ) as dst_file:
        src_file.write(src_bytes)
        src_file.flush()
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            src_file.name,
            *codecs[target],
            dst_file.name,
        ]
        try:
            subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (FileNotFoundError, subprocess.CalledProcessError) as exc:
            raise HTTPException(status_code=500, detail=f"ffmpeg failed: {exc}") from exc
        dst_file.seek(0)
        return dst_file.read()


async def transcode(src_bytes: bytes, target: str) -> bytes:
    return await asyncio.to_thread(_transcode, src_bytes, target)


async def list_voices() -> list[dict]:
    global _voice_cache
    if _voice_cache is None:
        voices = await edge_tts.list_voices()
        _voice_cache = [
            {
                "name": v.get("Name"),
                "shortName": v.get("ShortName"),
                "locale": v.get("Locale"),
                "localeName": v.get("LocaleName"),
                "gender": v.get("Gender"),
                "styleList": v.get("StyleList", []),
                "provider": "edge",
            }
            for v in voices
            if v.get("Locale") == "en-US"
        ]
    return _voice_cache + await _eleven_voices_cached()


async def _eleven_voices_cached() -> list[dict]:
    """ElevenLabs voices when a key is set. A failed listing is not cached and does not hide the Edge list."""
    global _eleven_voice_cache
    if not ELEVENLABS_API_KEY:
        return []
    if _eleven_voice_cache is None:
        try:
            _eleven_voice_cache = await _eleven_voices()
        except HTTPException as exc:
            print(f"ElevenLabs voice list unavailable: {exc.detail}")
            return []
        except Exception as exc:  # a malformed listing must not take the Edge voices down with it
            print(f"ElevenLabs voice list unavailable: {exc!r}")
            return []
    return _eleven_voice_cache


async def _eleven_voices_strict() -> list[dict]:
    """The ElevenLabs voices, or the real error when the listing fails (for /samples, which must say why)."""
    global _eleven_voice_cache
    if _eleven_voice_cache is None:
        _eleven_voice_cache = await _eleven_voices()
    return _eleven_voice_cache


@app.on_event("startup")
async def warm_voices_cache():
    try:
        await list_voices()
        # Kick off sample pre-render in background
        asyncio.create_task(pre_render_samples())
    except Exception:
        # Non-fatal; voice loading can retry on demand
        pass


async def pre_render_samples():
    try:
        voices = await list_voices()
        for v in voices:
            try:
                await ensure_sample(v["shortName"])
            except Exception:
                # Skip failures; samples can generate on-demand later
                continue
    except Exception:
        # Ignore errors; on-demand sample generation still works
        pass


@app.get("/voices")
async def voices(refresh: bool = False):
    global _voice_cache, _eleven_voice_cache
    if refresh:
        _voice_cache = None
        _eleven_voice_cache = None
    voices = await list_voices()
    for v in voices:
        v["sampleUrl"] = f"/samples/{v['shortName']}"
    return voices


@app.get("/")
async def tester():
    if not TESTER_HTML.exists():
        raise HTTPException(status_code=404, detail="tester.html not found")
    return FileResponse(TESTER_HTML, media_type="text/html")


@app.post("/synthesize")
async def synthesize(payload: SynthesisRequest):
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    mp3_bytes = await synthesize_mp3(payload.text, payload.voice)

    if payload.format == "mp3":
        return Response(mp3_bytes, media_type="audio/mpeg")

    transcoded = await transcode(mp3_bytes, payload.format)
    media_types = {
        "m4a": "audio/mp4",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
    }
    return Response(transcoded, media_type=media_types[payload.format])


@app.post("/synthesize_with_timing")
async def synthesize_with_timing(payload: SynthesisRequest):
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")

    mp3_bytes, boundaries = await synthesize_with_boundaries(payload.text, payload.voice)

    if payload.format != "mp3":
        mp3_bytes = await transcode(mp3_bytes, payload.format)

    audio_b64 = base64.b64encode(mp3_bytes).decode("ascii")
    media_types = {
        "mp3": "audio/mpeg",
        "m4a": "audio/mp4",
        "ogg": "audio/ogg",
        "flac": "audio/flac",
    }
    return {
        "audio": audio_b64,
        "contentType": media_types.get(payload.format, "audio/mpeg"),
        "format": payload.format,
        "boundaries": boundaries,
    }


async def ensure_sample(voice: str) -> Path:
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    sample_path = SAMPLES_DIR / (f"eleven-{voice[len(ELEVEN_PREFIX):]}.mp3" if voice.startswith(ELEVEN_PREFIX) else f"{voice}.mp3")
    if sample_path.exists():
        return sample_path
    if voice.startswith(ELEVEN_PREFIX):
        # The provider's own preview clip, so a sample costs no credits
        if not ELEVENLABS_API_KEY:
            raise HTTPException(status_code=503, detail="ElevenLabs voices are not configured on this server (no ELEVENLABS_API_KEY)")
        found = next((v for v in await _eleven_voices_strict() if v["shortName"] == voice), None)
        if found is None:
            raise HTTPException(status_code=404, detail="No such ElevenLabs voice on this account")
        if not found.get("previewUrl"):
            raise HTTPException(status_code=404, detail="This ElevenLabs voice has no preview clip")
        audio = await _eleven_fetch_bytes(found["previewUrl"])
    else:
        audio = await synthesize_mp3(SAMPLE_TEXT, voice)
    sample_path.write_bytes(audio)
    return sample_path


@app.get("/samples/{voice}")
async def sample_audio(voice: str):
    if not _valid_voice(voice):
        raise HTTPException(status_code=400, detail="Invalid voice name")
    try:
        path = await ensure_sample(voice)
        return FileResponse(path, media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Sample generation failed: {exc}")


async def _assert_public_host(url: str) -> None:
    """Reject URLs that resolve to private, loopback or link-local addresses (SSRF guard)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(parsed.hostname, None)
    except socket.gaierror:
        raise HTTPException(status_code=400, detail="Could not resolve URL host")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise HTTPException(status_code=400, detail="URL host is not allowed")


async def _fetch_html(url: str) -> str:
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (compatible; DanTTS/0.1; +https://github.com/danielwjohnston/dan-tts)",
            "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        }
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15), headers=headers) as session:
            # Follow redirects manually so every hop passes the SSRF check
            for _ in range(MAX_REDIRECTS + 1):
                await _assert_public_host(url)
                async with session.get(url, allow_redirects=False) as resp:
                    if resp.status in (301, 302, 303, 307, 308) and "Location" in resp.headers:
                        url = urljoin(url, resp.headers["Location"])
                        continue
                    if resp.status in (401, 403, 429):
                        raise HTTPException(
                            status_code=502,
                            detail=f"{urlparse(url).hostname} blocked automated access (HTTP {resp.status}). "
                            "Open the page in your browser and paste the text instead.",
                        )
                    if resp.status != 200:
                        raise HTTPException(status_code=502, detail=f"URL returned HTTP {resp.status}")
                    body = bytearray()
                    async for chunk in resp.content.iter_chunked(64 * 1024):
                        body.extend(chunk)
                        if len(body) > MAX_FETCH_BYTES:
                            raise HTTPException(status_code=413, detail="Page is too large")
                    return bytes(body).decode(resp.get_encoding() if resp.charset else "utf-8", errors="replace")
            raise HTTPException(status_code=502, detail="Too many redirects")
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch URL: {exc}")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="URL fetch timed out")


@app.post("/extract_text")
async def extract_text(payload: ExtractTextRequest):
    url = payload.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required")
    if url.startswith(("http://", "https://")):
        candidates = [url]
    elif "://" in url:
        raise HTTPException(status_code=400, detail="Only http:// and https:// URLs are supported")
    else:
        # Bare domain like "digg.com": try HTTPS first, then fall back to HTTP
        bare = url.lstrip("/")
        candidates = [f"https://{bare}", f"http://{bare}"]

    error: Optional[HTTPException] = None
    for candidate in candidates:
        try:
            html = await _fetch_html(candidate)
            break
        except HTTPException as exc:
            error = exc
    else:
        raise error

    soup = BeautifulSoup(html, "html.parser")
    # Grab the title and meta descriptions before pruning (a fallback for JS-rendered pages)
    meta_desc = ""
    for attrs in ({"property": "og:description"}, {"name": "description"}, {"name": "twitter:description"}):
        tag = soup.find("meta", attrs=attrs)
        if tag and tag.get("content", "").strip():
            meta_desc = tag["content"].strip()
            break
    title = _WS.sub(" ", soup.title.string).strip() if soup.title and soup.title.string else ""
    if soup.head is not None:
        soup.head.decompose()
    _prune(soup)
    text = _readable_text(_content_root(soup))
    if len(text.split()) < 5:
        if not meta_desc:
            raise HTTPException(
                status_code=422,
                detail="No readable text found; the page is probably rendered with JavaScript",
            )
        text = "\n\n".join(part for part in (title, meta_desc) if part)
    return {"text": text, "title": title, "chars": len(text)}


# ---- Load from URL: the readable text of a page ----
# The same rules as the Cloudflare Worker (worker/src/extract.js), so both servers read the
# same text: drop code, pictures, site chrome, hidden elements and form controls; read the
# first <main>, else the first <article>, else the body; blank lines between paragraphs.

# Never read aloud
_DROP_TAGS = {
    "script", "style", "noscript", "template", "svg", "math", "img", "picture", "nav", "header", "footer", "aside", "menu",
    "iframe", "object", "embed", "canvas", "video", "audio", "select", "button", "textarea", "datalist", "noframes",
}
# Paragraph breaks (a blank line) and plain line breaks
_PARA_TAGS = {
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "li", "figcaption", "hr", "dd", "dt", "tr", "caption", "summary",
    "details", "figure", "table", "ul", "ol", "dl",
}
_BLOCK_TAGS = {
    "div", "section", "article", "main", "body", "html", "address", "fieldset", "form", "legend", "td", "th", "thead", "tbody",
    "tfoot", "dialog", "center", "br", "label", "option",
}
_KEEP_ROOTS = {"html", "body", "main", "article"}
# Ids and classes that mark sidebars, menus and boxes, plus the generic markers MediaWiki sites
# (Wikisource, Wikipedia) and accessibility helpers use for things that aren't the text:
# print-hidden boxes, hatnotes, category links, "[edit]" links, screen-reader-only labels
_CHROME_HINT = re.compile(
    r"(^|[-_])(sidebar|side-box|menu|navbar|breadcrumbs?|cookies?|comments?|share|sharing|social|promo|ads?|advert(isement)?|toc"
    r"|masthead|site-header|site-footer|noprint|noexport|hatnote|catlinks|printfooter|editsection|sitesub|contentsub|indicators"
    r"|skip-link|sr-only|visually-hidden|screen-reader-text)([-_]|$)",
    re.I,
)
_CHROME_ROLE = re.compile(r"navigation|complementary|banner|contentinfo|button|menu|menubar|toolbar|search|dialog|tooltip|tablist|note")
_HIDDEN_STYLE = re.compile(r"(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)", re.I)
_WS = re.compile(r"[\s\u00a0]+")


def _is_chrome(tag: Tag) -> bool:
    """Site chrome, or not shown to sighted readers either: skip it."""
    attrs = tag.attrs
    role = attrs.get("role") or ""
    if _CHROME_ROLE.search(role if isinstance(role, str) else " ".join(role)):
        return True
    if "hidden" in attrs or attrs.get("aria-hidden") == "true" or "data-nosnippet" in attrs or _HIDDEN_STYLE.search(attrs.get("style") or ""):
        return True
    if tag.name in _KEEP_ROOTS:
        return False
    tokens = [attrs.get("id") or ""] + list(attrs.get("class") or [])
    return any(_CHROME_HINT.search(token) for token in tokens if token)


def _prune(soup: BeautifulSoup) -> None:
    """Remove everything that is never read aloud."""
    for tag in soup.find_all(True):
        if tag.decomposed:  # inside something already removed
            continue
        if tag.name in _DROP_TAGS or _is_chrome(tag):
            tag.decompose()


def _content_root(soup: BeautifulSoup):
    """The element holding the text: the first <main>, else the first <article>, else the body."""
    for name in ("main", "article"):
        found = soup.find(name)
        if found is not None:
            return found
    return soup.body or soup


def _readable_text(root) -> str:
    """Text with inline whitespace collapsed, line breaks at block boundaries and blank lines between paragraphs."""
    out: List[str] = []
    pending_break = 0
    pending_space = False

    def emit(raw: str) -> None:
        nonlocal pending_break, pending_space
        s = _WS.sub(" ", raw)
        if not s:
            return
        if s == " ":
            pending_space = True
            return
        lead, trail = s[0] == " ", s[-1] == " "
        s = s.strip()
        if pending_break:
            out.append("\n" * pending_break)
            pending_break = 0
        elif (pending_space or lead) and out:
            out.append(" ")
        out.append(s)
        pending_space = trail

    def brk(n: int) -> None:
        nonlocal pending_break
        if out:
            pending_break = max(pending_break, n)

    # Iterative walk: deeply nested pages would overflow a recursive one
    stack = [(root, False)]
    while stack:
        node, leaving = stack.pop()
        if isinstance(node, NavigableString):
            if not isinstance(node, PreformattedString):  # comments, doctypes and the like aren't text
                emit(str(node))
            continue
        name = node.name
        if name == "br":
            brk(1)
            continue
        if name == "hr":
            brk(2)
            continue
        size = 2 if name in _PARA_TAGS else 1 if name in _BLOCK_TAGS else 0
        if size:
            brk(size)
        if not leaving:
            stack.append((node, True))
            stack.extend((child, False) for child in reversed(node.contents))
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()


def _boundary_ms(boundary: dict) -> tuple:
    """Word boundary offsets/durations are in 100ns ticks; return (start_ms, end_ms)."""
    start = boundary["offset"] // 10000
    return start, (boundary["offset"] + boundary["duration"]) // 10000


def _timestamp(ms: int, frac_sep: str) -> str:
    """HH:MM:SS<sep>mmm, '.' for WebVTT and ',' for SRT."""
    return f"{ms // 3600000:02d}:{ms % 3600000 // 60000:02d}:{ms % 60000 // 1000:02d}{frac_sep}{ms % 1000:03d}"


@app.post("/export")
async def export_timing(payload: SynthesisRequest, format: str = "json"):
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")
    
    if format not in ["json", "webvtt", "srt"]:
        raise HTTPException(status_code=400, detail="Format must be 'json', 'webvtt' or 'srt'")
    
    # Get audio and timing data
    mp3_bytes, boundaries = await synthesize_with_boundaries(payload.text, payload.voice)
    
    if format == "json":
        # JSON bundle with audio base64 encoded
        audio_b64 = base64.b64encode(mp3_bytes).decode("ascii")
        return {
            "text": payload.text,
            "voice": payload.voice,
            "format": payload.format,
            "audio": audio_b64,
            "contentType": "audio/mpeg",
            "boundaries": boundaries,
            "metadata": {
                "words": len(boundaries),
                "duration_ms": (boundaries[-1]["offset"] + boundaries[-1]["duration"]) // 10000 if boundaries else 0,
                "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            }
        }
    elif format == "webvtt":
        lines = ["WEBVTT", ""]
        for b in boundaries:
            start, end = _boundary_ms(b)
            lines += [f"{_timestamp(start, '.')} --> {_timestamp(end, '.')}", b["text"], ""]
        return Response("\n".join(lines), media_type="text/vtt", headers={
            "Content-Disposition": 'attachment; filename="captions.vtt"'
        })
    else:
        lines = []
        for i, b in enumerate(boundaries, 1):
            start, end = _boundary_ms(b)
            lines += [str(i), f"{_timestamp(start, ',')} --> {_timestamp(end, ',')}", b["text"], ""]
        return Response("\n".join(lines), media_type="application/x-subrip", headers={
            "Content-Disposition": 'attachment; filename="captions.srt"'
        })


@app.get("/health")
async def health():
    return {"status": "ok", "providers": _providers()}


@app.get("/usage")
async def usage():
    return await _usage()
