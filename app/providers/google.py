"""Google Cloud Text-to-Speech. Voice ids are "google:<name>", e.g. "google:en-US-Neural2-F". Word timings:
the request is SSML with a <mark> before every word, and the service reports when each mark is reached.
The Chirp and Journey voices take no SSML, so their timings are estimated from the clip's length instead.
Needs GOOGLE_TTS_API_KEY (an API key restricted to the Text-to-Speech API). Same rules as worker/src/google.js."""

import base64
import json
import math
import os
import re
from typing import List, Tuple

from fastapi import HTTPException

from .common import TICKS, clean_text, error_body, estimate_boundaries, fetch, in_pieces, join_pieces, locales, mp3_ticks, pieces, ssml_with_marks

ID = "google"
NAME = "Google Cloud Text-to-Speech"
PREFIX = "google:"
ID_RE = re.compile(r"^google:[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9-]{1,60}\Z")
TIMINGS = "exact"
MAX_CHARS = 4000  # plain text per request (the API takes 5,000 bytes)
MAX_MARKED_CHARS = 1000  # with a mark before every word; the SSML is kept under the byte limit
SSML_BYTES = 4800
API = "https://texttospeech.googleapis.com/v1"
_GENDERS = {"MALE": "Male", "FEMALE": "Female"}

KEY = os.environ.get("GOOGLE_TTS_API_KEY", "").strip()
UNCONFIGURED = f"{NAME} voices are not configured on this server (no GOOGLE_TTS_API_KEY)"


def configured() -> bool:
    return bool(KEY)


def takes_ssml(name: str) -> bool:
    """Voices that take SSML, and so can report word timings."""
    return not re.search(r"Chirp|Journey", name, re.I)


def _headers() -> dict:
    return {"x-goog-api-key": KEY}


def _fail(status: int, body: bytes) -> HTTPException:
    err = error_body(body).get("error") or {}
    message = err.get("message") if isinstance(err.get("message"), str) else ""
    suffix = f" ({message})" if message else ""
    if status in (401, 403) or re.search(r"API key", message, re.I):
        return HTTPException(status_code=502, detail=f"{NAME} rejected the API key{suffix}: check GOOGLE_TTS_API_KEY on the server")
    if status == 429:
        return HTTPException(status_code=429, detail=f"{NAME} quota is used up or requests are being rate-limited; try again later. Edge voices still work")
    if status == 400 and re.search(r"voice", message, re.I):
        return HTTPException(status_code=400, detail=f"No such {NAME} voice{suffix}")
    if status == 400 and re.search(r"5000 bytes|too long|limit", message, re.I):
        return HTTPException(status_code=422, detail=f"Text is too long for {NAME} in one request")
    if status == 400:
        return HTTPException(status_code=400, detail=f"{NAME} rejected the request" + (f": {message}" if message else ""))
    return HTTPException(status_code=502, detail=f"{NAME} error: HTTP {status}{suffix}")


def _read_json(body: bytes) -> dict:
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail=f"{NAME} returned an unreadable response")
    return data


async def list_voices() -> List[dict]:
    """The voices for the configured locales, in the shape /voices returns for Edge voices. Listing is free."""
    wanted = locales()
    out: List[dict] = []
    seen = set()
    for locale in wanted or [""]:
        url = f"{API}/voices" + (f"?languageCode={locale}" if locale else "")
        status, _, body = await fetch(NAME, "GET", url, headers=_headers(), timeout=20)
        if status != 200:
            raise _fail(status, body)
        for v in _read_json(body).get("voices") or []:
            name = v.get("name") if isinstance(v, dict) else None
            if not isinstance(name, str) or name in seen or not ID_RE.match(PREFIX + name):
                continue
            seen.add(name)
            codes = v.get("languageCodes") if isinstance(v.get("languageCodes"), list) else []
            m = re.match(r"^[A-Za-z]{2,3}-[A-Za-z]{2,4}", name)
            code = (codes[0] if codes else None) or (m.group(0) if m else "")
            out.append({
                "name": re.sub(r"^[A-Za-z]{2,3}-[A-Za-z]{2,4}-", "", name).replace("-", " "),
                "shortName": f"{PREFIX}{name}",
                "locale": code,
                "localeName": code if takes_ssml(name) else f"{code} · Timings estimated",
                "gender": _GENDERS.get(v.get("ssmlGender"), ""),
                "styleList": [],
                "provider": ID,
            })
    return out


def timepoints_to_boundaries(timepoints, words: List[str], total_ticks: int) -> List[dict]:
    """Word boundaries from the marks the service reached, each lasting until the next (the last until the clip ends)."""
    at = {}
    for t in timepoints if isinstance(timepoints, list) else []:
        if not isinstance(t, dict) or not isinstance(t.get("timeSeconds"), (int, float)):
            continue
        try:
            i = int(str(t.get("markName")))
        except ValueError:
            continue
        if 0 <= i < len(words):
            at[i] = math.floor(t["timeSeconds"] * TICKS + 0.5)
    indexes = sorted(at)
    out = []
    for k, i in enumerate(indexes):
        offset = at[i]
        nxt = at[indexes[k + 1]] if k + 1 < len(indexes) else total_ticks
        out.append({"offset": offset, "duration": max(0, nxt - offset), "text": words[i]})
    return out


def marked_pieces(text: str, max_chars: int = MAX_MARKED_CHARS) -> List[str]:
    """The pieces of a marked-up text, each small enough for the byte limit once every word carries a mark."""
    out: List[str] = []
    for piece in pieces(text, max_chars):
        if len(ssml_with_marks(piece)[0].encode("utf-8")) <= SSML_BYTES or max_chars <= 100:
            out.append(piece)
        else:
            out.extend(marked_pieces(piece, max_chars // 2))
    return out


async def synthesize(text: str, voice: str) -> Tuple[bytes, List[dict]]:
    if not ID_RE.match(voice):
        raise HTTPException(status_code=400, detail="Invalid voice name")
    if not configured():
        raise HTTPException(status_code=503, detail=UNCONFIGURED)
    name = voice[len(PREFIX):]
    language_code = re.match(r"^[A-Za-z]{2,3}-[A-Za-z]{2,4}", name).group(0)
    marks = takes_ssml(name)

    async def one(piece: str) -> Tuple[bytes, List[dict]]:
        marked = ssml_with_marks(piece) if marks else None
        payload = {
            "input": {"ssml": f"<speak>{marked[0]}</speak>"} if marked else {"text": clean_text(piece)},
            "voice": {"languageCode": language_code, "name": name},
            "audioConfig": {"audioEncoding": "MP3"},
        }
        if marked:
            payload["enableTimePointing"] = ["SSML_MARK"]
        status, _, body = await fetch(NAME, "POST", f"{API}/text:synthesize", headers=_headers(), json_body=payload)
        if status != 200:
            raise _fail(status, body)
        data = _read_json(body)
        if not isinstance(data.get("audioContent"), str) or not data["audioContent"]:
            raise HTTPException(status_code=502, detail=f"{NAME} returned no audio")
        try:
            audio = base64.b64decode(data["audioContent"], validate=True)
        except (ValueError, TypeError):
            raise HTTPException(status_code=502, detail=f"{NAME} returned unreadable audio")
        ticks = mp3_ticks(audio)
        boundaries = timepoints_to_boundaries(data.get("timepoints"), marked[1], ticks) if marked else estimate_boundaries(piece, ticks)
        return audio, boundaries

    if not marks:
        return await in_pieces(text, MAX_CHARS, one)
    parts = [await one(piece) for piece in marked_pieces(text)]
    if not parts:
        raise HTTPException(status_code=400, detail="Text is required")
    audio, boundaries, _ = join_pieces(parts)
    return audio, boundaries
