"""Azure AI Speech (Microsoft's licensed service). Voice ids are "azure:<ShortName>", e.g.
"azure:en-US-JennyNeural". The official WebSocket endpoint speaks the protocol the Edge path uses, with a
key header and real SSML (break tags from the markup editor); word timings come from the service itself.
Needs AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (e.g. "eastus"). Same rules as worker/src/azure.js."""

import asyncio
import json
import os
import re
import secrets
from datetime import datetime, timezone
from typing import List, Tuple

import aiohttp
from fastapi import HTTPException

from .common import fetch, in_pieces, locale_ok, locales, ssml_body, title

ID = "azure"
NAME = "Azure AI Speech"
PREFIX = "azure:"
ID_RE = re.compile(r"^azure:[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9:-]{3,80}\Z")
TIMINGS = "exact"
MAX_CHARS = 8000  # per WebSocket turn (the service caps a turn at ten minutes of audio)

KEY = os.environ.get("AZURE_SPEECH_KEY", "").strip()
REGION = os.environ.get("AZURE_SPEECH_REGION", "").strip()
UNCONFIGURED = f"{NAME} voices are not configured on this server (no AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)"


def configured() -> bool:
    return bool(KEY and REGION)


def _host() -> str:
    return f"{REGION}.tts.speech.microsoft.com"


def _fail(status: int, message: str = "") -> HTTPException:
    suffix = f" ({message})" if message else ""
    if status in (401, 403):
        return HTTPException(status_code=502, detail=f"{NAME} rejected the key or region{suffix}: check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION on the server")
    if status == 429:
        return HTTPException(status_code=429, detail=f"{NAME} is rate-limiting requests; try again in a moment")
    return HTTPException(status_code=502, detail=f"{NAME} error: HTTP {status}{suffix}")


async def list_voices() -> List[dict]:
    """The region's voices, in the shape /voices returns for Edge voices. Listing is free."""
    status, _, body = await fetch(NAME, "GET", f"https://{_host()}/cognitiveservices/voices/list", headers={"Ocp-Apim-Subscription-Key": KEY}, timeout=20)
    if status != 200:
        raise _fail(status, body.decode("utf-8", "replace")[:120])
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if not isinstance(data, list):
        raise HTTPException(status_code=502, detail=f"{NAME} returned an unreadable response")
    wanted = locales()
    out = []
    for v in data:
        if not isinstance(v, dict) or not isinstance(v.get("ShortName"), str) or not locale_ok(wanted, v.get("Locale")) or not ID_RE.match(PREFIX + v["ShortName"]):
            continue
        voice_type = v.get("VoiceType") or ""
        out.append({
            "name": v.get("DisplayName") or v.get("LocalName") or v["ShortName"],
            "shortName": f"{PREFIX}{v['ShortName']}",
            "locale": v.get("Locale") or "",
            "localeName": " · ".join(x for x in (v.get("LocaleName"), voice_type if voice_type != "Neural" else "") if x),
            "gender": title(v.get("Gender") or ""),
            "styleList": v.get("StyleList") if isinstance(v.get("StyleList"), list) else [],
            "provider": ID,
        })
    return out


def ssml_for(text: str, short_name: str) -> str:
    """The SSML document for one piece of text: the voice's own language, break tags kept."""
    m = re.match(r"^([A-Za-z]{2,3}-[A-Za-z]{2,4})", short_name)
    lang = m.group(1) if m else "en-US"
    return (f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='{lang}'>"
            f"<voice name='{short_name}'>{ssml_body(text, 5000)}</voice></speak>")


# ---- The speech WebSocket protocol (the same one engine/src/tts.js speaks) ----
def _js_date() -> str:
    return datetime.now(timezone.utc).strftime("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")


def _parse_text_frame(text: str) -> Tuple[dict, str]:
    head, _, body = text.partition("\r\n\r\n")
    headers = {}
    for line in head.split("\r\n"):
        k, sep, v = line.partition(":")
        if sep:
            headers[k] = v
    return headers, body


def _parse_binary_frame(data: bytes) -> Tuple[dict, bytes]:
    n = (data[0] << 8) | data[1]
    headers = {}
    for line in data[2:2 + n].decode("utf-8", "replace").split("\r\n"):
        k, sep, v = line.partition(":")
        if sep:
            headers[k] = v
    return headers, data[2 + n:]


_UNESCAPE = {"amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'"}


def _unescape_xml(s: str) -> str:
    return re.sub(r"&(amp|lt|gt|quot|apos);", lambda m: _UNESCAPE[m.group(1)], s)


async def speak_on(ws, ssml: str) -> Tuple[bytes, List[dict]]:
    """Send the configuration and the SSML on an open socket, then collect audio and word boundaries until
    the turn ends. The socket needs send_str() and asynchronous iteration over messages (aiohttp's)."""
    await ws.send_str(
        f"X-Timestamp:{_js_date()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},'
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
    )
    await ws.send_str(f"X-RequestId:{secrets.token_hex(16)}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{_js_date()}Z\r\nPath:ssml\r\n\r\n{ssml}")
    parts: List[bytes] = []
    boundaries: List[dict] = []
    async for msg in ws:
        if msg.type == aiohttp.WSMsgType.TEXT:
            headers, body = _parse_text_frame(msg.data)
            if headers.get("Path") == "audio.metadata":
                for m in json.loads(body).get("Metadata") or []:
                    data = m.get("Data") or {}
                    text = data.get("text") or {}
                    # Azure also reports punctuation as its own boundary; the highlighter wants words only
                    if m.get("Type") == "WordBoundary" and text.get("BoundaryType") != "PunctuationBoundary":
                        boundaries.append({"offset": data.get("Offset", 0), "duration": data.get("Duration", 0), "text": _unescape_xml(str(text.get("Text", "")))})
            elif headers.get("Path") == "turn.end":
                break
        elif msg.type == aiohttp.WSMsgType.BINARY:
            headers, audio = _parse_binary_frame(msg.data)
            if headers.get("Path") == "audio" and audio:
                parts.append(audio)
        elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
            break
    if not parts:
        raise HTTPException(status_code=502, detail=f"{NAME} returned no audio")
    return b"".join(parts), boundaries


async def _speak(ssml: str) -> Tuple[bytes, List[dict]]:
    url = f"wss://{_host()}/cognitiveservices/websocket/v1?X-ConnectionId={secrets.token_hex(16)}"
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=60)) as session:
            async with session.ws_connect(url, headers={"Ocp-Apim-Subscription-Key": KEY}) as ws:
                return await speak_on(ws, ssml)
    except aiohttp.WSServerHandshakeError as exc:
        raise _fail(exc.status, exc.message)
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"{NAME} error: {exc}")
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail=f"{NAME} timed out")


async def synthesize(text: str, voice: str) -> Tuple[bytes, List[dict]]:
    if not ID_RE.match(voice):
        raise HTTPException(status_code=400, detail="Invalid voice name")
    if not configured():
        raise HTTPException(status_code=503, detail=UNCONFIGURED)
    short_name = voice[len(PREFIX):]
    return await in_pieces(text, MAX_CHARS, lambda piece: _speak(ssml_for(piece, short_name)))
