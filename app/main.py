"""
Dan's TTS Project (FastAPI)
- Uses Microsoft Edge TTS voices (no API key) via edge-tts
- Returns MP3 directly; transcodes to m4a/ogg/flac with ffmpeg
"""

import asyncio
import base64
import ipaddress
import re
import socket
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional
from urllib.parse import urljoin, urlparse

import aiohttp
import edge_tts
from bs4 import BeautifulSoup
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
VOICE_NAME_RE = re.compile(r"^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$")

_voice_cache: Optional[List[Dict]] = None

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


async def synthesize_mp3(text: str, voice: str) -> bytes:
    communicator = edge_tts.Communicate(text, voice=voice)
    audio_chunks = []
    async for chunk in communicator.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
    if not audio_chunks:
        raise HTTPException(status_code=500, detail="No audio returned from TTS")
    return b"".join(audio_chunks)


async def synthesize_with_boundaries(text: str, voice: str):
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
            }
            for v in voices
            if v.get("Locale") == "en-US"
        ]
    return _voice_cache


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
    global _voice_cache
    if refresh:
        _voice_cache = None
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
    sample_path = SAMPLES_DIR / f"{voice}.mp3"
    if sample_path.exists():
        return sample_path
    audio = await synthesize_mp3(SAMPLE_TEXT, voice)
    sample_path.write_bytes(audio)
    return sample_path


@app.get("/samples/{voice}")
async def sample_audio(voice: str):
    if not VOICE_NAME_RE.match(voice):
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
    # Grab meta descriptions before stripping tags, as a fallback for JS-rendered pages
    meta_desc = ""
    for attrs in ({"property": "og:description"}, {"name": "description"}, {"name": "twitter:description"}):
        tag = soup.find("meta", attrs=attrs)
        if tag and tag.get("content", "").strip():
            meta_desc = tag["content"].strip()
            break
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript", "svg", "img"]):
        tag.decompose()
    main = _content_root(soup)
    text = main.get_text(separator="\n", strip=True)
    # Collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    if len(text.split()) < 5:
        if not meta_desc:
            raise HTTPException(
                status_code=422,
                detail="No readable text found; the page is probably rendered with JavaScript",
            )
        text = "\n\n".join(part for part in (title, meta_desc) if part)
    return {"text": text, "title": title, "chars": len(text)}


_CHROME_HINT = re.compile(r"sidebar|side-bar|menu|navbar|breadcrumb|cookie|comment|share|social|promo|advert|infobox|toc", re.I)


def _content_root(soup: BeautifulSoup):
    """Pick the element holding the article text, without reading site chrome.

    Sidebars, menus and boxes are dropped first, then the <main> or <article> wins
    when present. Otherwise the block with the most paragraph text is used, so a
    page's sidebar and header are not read aloud along with its content.
    """
    for tag in soup.find_all(attrs={"role": re.compile("navigation|complementary|banner|contentinfo")}):
        tag.decompose()
    for tag in soup.find_all(["aside", "menu"]):
        tag.decompose()
    for tag in soup.find_all(True):
        if tag.parent is None:
            continue
        hint = " ".join(filter(None, [tag.get("id"), " ".join(tag.get("class") or [])]))
        if hint and _CHROME_HINT.search(hint):
            tag.decompose()
    for name in ("main", "article"):
        found = soup.find(name)
        if found is not None:
            return found
    best, best_words = None, 0
    for block in soup.find_all(["div", "section", "td"]):
        words = sum(len(p.get_text(" ", strip=True).split()) for p in block.find_all("p", recursive=False))
        if words > best_words:
            best, best_words = block, words
    return best or soup.body or soup


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
    return {"status": "ok"}
