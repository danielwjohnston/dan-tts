"""Amazon Polly. Voice ids are "polly:<VoiceId>", e.g. "polly:Joanna". Each piece of text is two signed
requests: the MP3, and the word speech marks that give exact word timings. Requests are signed with AWS
Signature Version 4 here (no SDK). Needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; AWS_REGION defaults
to us-east-1; POLLY_ENGINE picks the engine (default neural, with a fallback to standard for voices that
lack it). Same rules as worker/src/polly.js."""

import asyncio
import hashlib
import hmac
import json
import os
import re
from datetime import datetime, timezone
from typing import List, Optional, Tuple
from urllib.parse import quote, urlencode, urlparse, parse_qsl

from fastapi import HTTPException

from .common import clean_text, error_body, fetch, has_breaks, in_pieces, locale_ok, locales, mp3_ticks, ssml_body

ID = "polly"
NAME = "Amazon Polly"
PREFIX = "polly:"
ID_RE = re.compile(r"^polly:[A-Za-z0-9_-]{2,40}\Z")
TIMINGS = "exact"
MAX_CHARS = 2500  # billed characters per request (the API takes 3,000)
DEFAULT_ENGINE = "neural"
DEFAULT_REGION = "us-east-1"

ACCESS_KEY = os.environ.get("AWS_ACCESS_KEY_ID", "").strip()
SECRET_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "").strip()
SESSION_TOKEN = os.environ.get("AWS_SESSION_TOKEN", "").strip()
REGION = os.environ.get("AWS_REGION", "").strip() or DEFAULT_REGION
ENGINE = os.environ.get("POLLY_ENGINE", "").strip() or DEFAULT_ENGINE
UNCONFIGURED = f"{NAME} voices are not configured on this server (no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)"


def configured() -> bool:
    return bool(ACCESS_KEY and SECRET_KEY)


def _endpoint() -> str:
    return f"https://polly.{REGION}.amazonaws.com"


# ---- AWS Signature Version 4 ----
def _rfc3986(s: str) -> str:
    return quote(s, safe="-_.~")


def amz_date(now: datetime) -> str:
    return now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def signing_key(secret: str, day: str, region: str, service: str) -> bytes:
    """The derived signing key for a day, region and service."""
    k = f"AWS4{secret}".encode()
    for part in (day, region, service, "aws4_request"):
        k = hmac.new(k, part.encode(), hashlib.sha256).digest()
    return k


def sign_v4(method: str, url: str, body: str = "", *, now: Optional[datetime] = None, access_key: Optional[str] = None,
            secret_key: Optional[str] = None, session_token: Optional[str] = None, region: Optional[str] = None) -> dict:
    """Headers that sign a request (SigV4, service "polly"): x-amz-date, x-amz-content-sha256, Authorization
    and, with temporary credentials, x-amz-security-token."""
    access_key = ACCESS_KEY if access_key is None else access_key
    secret_key = SECRET_KEY if secret_key is None else secret_key
    session_token = SESSION_TOKEN if session_token is None else session_token
    region = REGION if region is None else region
    u = urlparse(url)
    date = amz_date(now or datetime.now(timezone.utc))
    day = date[:8]
    payload_hash = hashlib.sha256(body.encode()).hexdigest()
    headers = {"host": u.netloc, "x-amz-content-sha256": payload_hash, "x-amz-date": date}
    if session_token:
        headers["x-amz-security-token"] = session_token
    names = sorted(headers)
    pairs = sorted((_rfc3986(k), _rfc3986(v)) for k, v in parse_qsl(u.query, keep_blank_values=True))
    query = "&".join(f"{k}={v}" for k, v in pairs)
    canonical = "\n".join([method, "/".join(_rfc3986(seg) for seg in u.path.split("/")), query, *(f"{n}:{headers[n].strip()}" for n in names), "", ";".join(names), payload_hash])
    scope = f"{day}/{region}/polly/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", date, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signature = hmac.new(signing_key(secret_key, day, region, "polly"), to_sign.encode(), hashlib.sha256).hexdigest()
    out = {k: v for k, v in headers.items() if k != "host"}  # aiohttp sets Host itself
    out["Authorization"] = f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={';'.join(names)}, Signature={signature}"
    return out


def _fail(status: int, headers: dict, body: bytes) -> HTTPException:
    kind = (headers.get("x-amzn-errortype") or "").split(":")[0]
    data = error_body(body)
    message = data.get("message") if isinstance(data.get("message"), str) else data.get("Message") if isinstance(data.get("Message"), str) else ""
    if not kind and isinstance(data.get("__type"), str):
        kind = data["__type"].split("#")[-1]
    suffix = f" ({message})" if message else ""
    if status == 403 or re.search(r"InvalidSignature|UnrecognizedClient|InvalidClientTokenId|AccessDenied", kind, re.I):
        return HTTPException(status_code=502, detail=f"{NAME} rejected the credentials{suffix}: check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION on the server")
    if re.search(r"TextLengthExceeded", kind, re.I):
        return HTTPException(status_code=422, detail=f"Text is too long for {NAME} in one request (limit about {MAX_CHARS} characters)")
    if status == 429 or re.search(r"Throttling|LimitExceeded", kind, re.I):
        return HTTPException(status_code=429, detail=f"{NAME} is rate-limiting requests; try again in a moment")
    if re.search(r"InvalidSsml|SsmlMarksNotSupported", kind, re.I):
        return HTTPException(status_code=400, detail=f"{NAME} rejected the SSML{suffix}")
    if re.search(r"EngineNotSupported", kind, re.I):
        return HTTPException(status_code=400, detail=f"This {NAME} voice does not support the {DEFAULT_ENGINE} engine{suffix}")
    if status == 400 and re.search(r"ValidationException|voice", kind + message, re.I):
        return HTTPException(status_code=400, detail=f"No such {NAME} voice{suffix}")
    return HTTPException(status_code=502, detail=f"{NAME} error: HTTP {status}" + (f" {kind}" if kind else "") + suffix)


async def _call(method: str, path: str, body: str = "", timeout: int = 60) -> Tuple[int, dict, bytes]:
    url = f"{_endpoint()}{path}"
    headers = sign_v4(method, url, body)
    if body:
        headers["Content-Type"] = "application/json"
    return await fetch(NAME, method, url, headers=headers, data=body.encode() if body else None, timeout=timeout)


async def list_voices() -> List[dict]:
    """The voices for the configured locales, in the shape /voices returns for Edge voices. Listing is free."""
    wanted = locales()
    out: List[dict] = []
    seen = set()
    for locale in wanted or [""]:
        token = ""
        for _ in range(10):
            params = {}
            if locale:
                params["LanguageCode"] = locale
            if token:
                params["NextToken"] = token
            status, headers, body = await _call("GET", "/v1/voices" + (f"?{urlencode(params)}" if params else ""), timeout=20)
            if status != 200:
                raise _fail(status, headers, body)
            try:
                data = json.loads(body)
            except ValueError:
                data = None
            if not isinstance(data, dict):
                raise HTTPException(status_code=502, detail=f"{NAME} returned an unreadable response")
            for v in data.get("Voices") or []:
                vid = v.get("Id") if isinstance(v, dict) else None
                if not isinstance(vid, str) or vid in seen or not ID_RE.match(PREFIX + vid) or not locale_ok(wanted, v.get("LanguageCode")):
                    continue
                seen.add(vid)
                engines = v.get("SupportedEngines") if isinstance(v.get("SupportedEngines"), list) else []
                out.append({
                    "name": v.get("Name") or vid,
                    "shortName": f"{PREFIX}{vid}",
                    "locale": v.get("LanguageCode") or "",
                    "localeName": " · ".join(x for x in (v.get("LanguageName"), "" if "neural" in engines else "/".join(engines)) if x),
                    "gender": v.get("Gender") or "",
                    "styleList": [],
                    "provider": ID,
                })
            token = data.get("NextToken") if isinstance(data.get("NextToken"), str) else ""
            if not token:
                break
    return out


def marks_to_boundaries(marks_text: str, total_ticks: int) -> List[dict]:
    """Word speech marks (one JSON object per line) → word boundaries, each lasting until the next word (the last until the clip ends)."""
    marks = []
    for line in str(marks_text).split("\n"):
        if not line.strip():
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if isinstance(m, dict) and m.get("type") == "word" and isinstance(m.get("time"), (int, float)) and isinstance(m.get("value"), str):
            marks.append(m)
    out = []
    for i, m in enumerate(marks):
        offset = int(m["time"]) * 10000
        nxt = int(marks[i + 1]["time"]) * 10000 if i + 1 < len(marks) else total_ticks
        out.append({"offset": offset, "duration": max(0, nxt - offset), "text": m["value"]})
    return out


async def synthesize(text: str, voice: str) -> Tuple[bytes, List[dict]]:
    if not ID_RE.match(voice):
        raise HTTPException(status_code=400, detail="Invalid voice name")
    if not configured():
        raise HTTPException(status_code=503, detail=UNCONFIGURED)
    voice_id = voice[len(PREFIX):]
    engine = ENGINE

    async def one(piece: str) -> Tuple[bytes, List[dict]]:
        nonlocal engine
        ssml = has_breaks(piece)
        base = {"VoiceId": voice_id, "Text": f"<speak>{ssml_body(piece, 5000)}</speak>" if ssml else clean_text(piece), "TextType": "ssml" if ssml else "text"}

        async def both():
            return await asyncio.gather(
                _call("POST", "/v1/speech", json.dumps({**base, "Engine": engine, "OutputFormat": "mp3"})),
                _call("POST", "/v1/speech", json.dumps({**base, "Engine": engine, "OutputFormat": "json", "SpeechMarkTypes": ["word"]})),
            )

        (a_status, a_headers, audio), (m_status, m_headers, marks) = await both()
        if a_status != 200 and engine != "standard" and re.search(r"EngineNotSupported", a_headers.get("x-amzn-errortype") or "", re.I):
            # The voice lacks this engine: the rest of the request uses the standard one
            engine = "standard"
            (a_status, a_headers, audio), (m_status, m_headers, marks) = await both()
        if a_status != 200:
            raise _fail(a_status, a_headers, audio)
        if m_status != 200:
            raise _fail(m_status, m_headers, marks)
        if not audio:
            raise HTTPException(status_code=502, detail=f"{NAME} returned no audio")
        return audio, marks_to_boundaries(marks.decode("utf-8", "replace"), mp3_ticks(audio))

    return await in_pieces(text, MAX_CHARS, one)
