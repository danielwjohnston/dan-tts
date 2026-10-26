"""OpenAI text to speech. Voice ids are "openai:<voice>", e.g. "openai:alloy". The API returns audio
only, no word timings, so the highlighter gets timings estimated from the clip's length and the words'
lengths (good enough to follow, never exact). Needs OPENAI_API_KEY; OPENAI_TTS_MODEL picks the model
(default gpt-4o-mini-tts). Same rules as worker/src/openai.js."""

import os
import re
from typing import List, Tuple

from fastapi import HTTPException

from .common import clean_text, error_body, estimate_boundaries, fetch, in_pieces, mp3_ticks, title

ID = "openai"
NAME = "OpenAI"
PREFIX = "openai:"
ID_RE = re.compile(r"^openai:[a-z]{3,20}\Z")
TIMINGS = "estimated"
DEFAULT_MODEL = "gpt-4o-mini-tts"
MAX_CHARS = 4000  # the API takes 4096 per request
API = "https://api.openai.com"
# The API has no voice listing; these are the voices it documents, in its order
VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"]

KEY = os.environ.get("OPENAI_API_KEY", "").strip()
MODEL = os.environ.get("OPENAI_TTS_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
UNCONFIGURED = f"{NAME} voices are not configured on this server (no OPENAI_API_KEY)"


def configured() -> bool:
    return bool(KEY)


def _fail(status: int, body: bytes) -> HTTPException:
    err = error_body(body).get("error") or {}
    message = err.get("message") if isinstance(err.get("message"), str) else ""
    suffix = f" ({message})" if message else ""
    if status == 401:
        return HTTPException(status_code=502, detail=f"{NAME} rejected the API key{suffix}: check OPENAI_API_KEY on the server")
    if status == 429 and "insufficient_quota" in (err.get("type"), err.get("code")):
        return HTTPException(status_code=429, detail=f"The {NAME} account is out of credit. Edge voices still work; add credit on platform.openai.com")
    if status == 429:
        return HTTPException(status_code=429, detail=f"{NAME} is rate-limiting requests; try again in a moment")
    if status == 400 and err.get("param") == "voice":
        return HTTPException(status_code=400, detail=f"No such {NAME} voice")
    if status == 400 and err.get("param") == "input":
        return HTTPException(status_code=422, detail=f"Text is too long for {NAME} in one request (limit about {MAX_CHARS} characters)")
    if status == 400:
        return HTTPException(status_code=400, detail=f"{NAME} rejected the request" + (f": {message}" if message else ""))
    return HTTPException(status_code=502, detail=f"{NAME} error: HTTP {status}{suffix}")


async def list_voices() -> List[dict]:
    """The documented voices, in the shape /voices returns for Edge voices. No network."""
    return [
        {"name": title(v), "shortName": f"{PREFIX}{v}", "locale": "", "localeName": "Timings estimated", "gender": "", "styleList": [], "provider": ID}
        for v in VOICES
    ]


async def synthesize(text: str, voice: str) -> Tuple[bytes, List[dict]]:
    if not ID_RE.match(voice):
        raise HTTPException(status_code=400, detail="Invalid voice name")
    if not configured():
        raise HTTPException(status_code=503, detail=UNCONFIGURED)
    name = voice[len(PREFIX):]

    async def one(piece: str) -> Tuple[bytes, List[dict]]:
        status, _, body = await fetch(
            NAME, "POST", f"{API}/v1/audio/speech",
            headers={"Authorization": f"Bearer {KEY}"},
            json_body={"model": MODEL, "input": clean_text(piece), "voice": name, "response_format": "mp3"},
        )
        if status != 200:
            raise _fail(status, body)
        if not body:
            raise HTTPException(status_code=502, detail=f"{NAME} returned no audio")
        return body, estimate_boundaries(piece, mp3_ticks(body))

    return await in_pieces(text, MAX_CHARS, one)
