"""
Dan's TTS Project (FastAPI)
- Uses Microsoft Edge TTS voices (no API key) via edge-tts
- Returns MP3 directly; transcodes to m4a/ogg/flac with ffmpeg
"""

import asyncio
import base64
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Dict, List, Literal, Optional

import aiohttp
import edge_tts
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from starlette.responses import FileResponse, Response

SUPPORTED_FORMATS = Literal["mp3", "m4a", "ogg", "flac"]
DEFAULT_VOICE = "en-US-AriaNeural"
BASE_DIR = Path(__file__).resolve().parent.parent
TESTER_HTML = BASE_DIR / "tester.html"
SAMPLE_TEXT = "This is a sample of the selected voice."
SAMPLES_DIR = BASE_DIR / "samples"

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


class SynthesisRequest(BaseModel):
    text: str = Field(..., description="Plain text or SSML to synthesize")
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
    try:
        path = await ensure_sample(voice)
        return FileResponse(path, media_type="audio/mpeg")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Sample generation failed: {exc}")


@app.post("/extract_text")
async def extract_text(payload: ExtractTextRequest):
    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must start with http:// or https://")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status != 200:
                    raise HTTPException(status_code=502, detail=f"URL returned HTTP {resp.status}")
                html = await resp.text()
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch URL: {exc}")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="URL fetch timed out")

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer", "noscript", "svg", "img"]):
        tag.decompose()
    # Try to get main content first
    main = soup.find("main") or soup.find("article") or soup.find("body")
    if main is None:
        main = soup
    text = main.get_text(separator="\n", strip=True)
    # Collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    return {"text": text, "title": title, "chars": len(text)}


@app.get("/health")
async def health():
    return {"status": "ok"}
