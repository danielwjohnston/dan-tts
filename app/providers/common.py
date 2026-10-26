"""Shared by the hosted providers (the same functions as worker/src/audio.js): MP3 frame walking
(how long a clip plays, clean joins of several clips), estimated word timings for providers that
report none, splitting text into pieces a provider accepts in one request, SSML escaping that keeps
break tags, and an HTTP call that turns network trouble into plain-language HTTPExceptions."""

import asyncio
import math
import os
import re
from typing import Awaitable, Callable, Iterable, List, Optional, Tuple

import aiohttp
from fastapi import HTTPException

TICKS = 10_000_000  # ticks (100 ns) per second: the unit of every word boundary

# ---- MP3 frames (Layer III, which is what every provider returns) ----
_SAMPLE_RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}  # by version bits
_BITRATES_V1 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
_BITRATES_V2 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)


def _frame_at(b: bytes, i: int) -> Optional[Tuple[int, int, int]]:
    """(length, samples, sample rate) of the frame header at i, or None when the bytes there are not one."""
    if i + 4 > len(b) or b[i] != 0xFF or (b[i + 1] & 0xE0) != 0xE0:
        return None
    version = (b[i + 1] >> 3) & 3  # 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    layer = (b[i + 1] >> 1) & 3  # 1 = Layer III
    bitrate, rate, padding = b[i + 2] >> 4, (b[i + 2] >> 2) & 3, (b[i + 2] >> 1) & 1
    if version == 1 or layer != 1 or bitrate in (0, 15) or rate == 3:
        return None
    sample_rate = _SAMPLE_RATES[version][rate]
    kbps = (_BITRATES_V1 if version == 3 else _BITRATES_V2)[bitrate]
    samples = 1152 if version == 3 else 576
    return (samples // 8) * kbps * 1000 // sample_rate + padding, samples, sample_rate


def _is_tag(b: bytes, i: int) -> bool:
    return b[i:i + 3] == b"TAG"  # ID3v1


def mp3_frames(data: bytes) -> Tuple[bytes, int]:
    """The MP3's frames alone (ID3 tags and anything else dropped, so clips join cleanly) and how long
    they play, in ticks. Bytes that are not Layer III frames give (b"", 0)."""
    b = bytes(data)
    i = 0
    if len(b) >= 10 and b[:3] == b"ID3":  # a syncsafe size, plus a footer when flagged
        i = 10 + (((b[6] & 0x7F) << 21) | ((b[7] & 0x7F) << 14) | ((b[8] & 0x7F) << 7) | (b[9] & 0x7F)) + (10 if b[5] & 0x10 else 0)
    parts: List[bytes] = []
    ticks = 0
    n = len(b)
    while i + 4 <= n:
        f = _frame_at(b, i)
        # A frame is believed when another frame, the end, or an ID3v1 tag follows it: a lone sync word in junk is not one
        if f is None or i + f[0] > n or not (i + f[0] + 4 > n or _frame_at(b, i + f[0]) or _is_tag(b, i + f[0])):
            i += 1
            continue
        length, samples, sample_rate = f
        parts.append(b[i:i + length])
        ticks += samples * TICKS // sample_rate
        i += length
    return b"".join(parts), ticks


def mp3_ticks(data: bytes) -> int:
    """How long a clip plays, in ticks (0 when the bytes cannot be read as MP3)."""
    return mp3_frames(data)[1]


def join_pieces(pieces_: List[Tuple[bytes, List[dict]]]) -> Tuple[bytes, List[dict], int]:
    """One clip from the pieces of a longer text: frames only, each piece's boundaries shifted by the
    playing time of the pieces before it. A piece that is not readable MP3 is kept as it is and adds no time."""
    if len(pieces_) == 1:
        audio, boundaries = pieces_[0]
        return audio, boundaries, mp3_ticks(audio)
    audios: List[bytes] = []
    boundaries: List[dict] = []
    total = 0
    for audio, bounds in pieces_:
        frames, ticks = mp3_frames(audio)
        audios.append(frames or audio)
        boundaries.extend({"offset": b["offset"] + total, "duration": b["duration"], "text": b["text"]} for b in bounds)
        total += ticks
    return b"".join(audios), boundaries, total


# ---- Estimated word timings, for providers that report none (OpenAI; Google's Chirp voices) ----
# Each word takes time in proportion to its letters, plus a gap; sentence and clause ends add a pause.
_WORD_CHAR = re.compile(r"[^\W_]")
_SENTENCE_END = re.compile(r"[.!?…][\"')\]]*$")
_CLAUSE_END = re.compile(r"[,;:—–-][\"')\]]*$")


def estimate_boundaries(text: str, total_ticks: int) -> List[dict]:
    words = str(text).split()
    if not words or not total_ticks > 0:
        return []
    weights = []
    for w in words:
        letters = len(_WORD_CHAR.findall(w))
        pause = 3 if _SENTENCE_END.search(w) else 1.5 if _CLAUSE_END.search(w) else 0
        weights.append((max(1, letters) + 1, pause))
    total = sum(w + p for w, p in weights)
    out = []
    cum = 0.0
    for word, (w, p) in zip(words, weights):
        offset = math.floor(total_ticks * cum / total)
        cum += w
        end = math.floor(total_ticks * cum / total)
        cum += p
        out.append({"offset": offset, "duration": end - offset, "text": word})
    return out


# ---- Text pieces ----
# A dot between digits (3.50, a <break time="1.5s" /> tag) is not a sentence end
_SENTENCES = re.compile(r"(?:[^.!?]|(?<=\d)\.(?=\d))+(?:[.!?]+[\"')\]]*\s*|$)")
_BREAK_TAG = re.compile(r'<break\s+time="(\d+(?:\.\d+)?)\s*(ms|s)"\s*/>', re.I)


def _cut_point(s: str, max_chars: int) -> int:
    """Where to cut a run of text at or before max: after whitespace, never inside a break tag."""
    cut = s.rfind(" ", 0, max_chars + 1)
    if cut <= 0:
        cut = max_chars
    open_ = s.rfind("<break", 0, cut + 1)
    if open_ >= 0 and s.find("/>", open_) >= cut:  # the tag straddles the cut: cut before it
        cut = open_ if open_ > 0 else max_chars
    return cut


def _split_long(para: str, max_chars: int) -> List[str]:
    out: List[str] = []
    cur = ""
    for s in [m for m in _SENTENCES.findall(para) if m] or [para]:
        if cur and len(cur + s) > max_chars:
            out.append(cur.strip())
            cur = ""
        if len(s) > max_chars:
            rest = s
            while len(rest) > max_chars:
                cut = _cut_point(rest, max_chars)
                out.append(rest[:cut].strip())
                rest = rest[cut:]
            cur = rest
        else:
            cur += s
    if cur.strip():
        out.append(cur.strip())
    return out


def pieces(text: str, max_chars: int) -> List[str]:
    """Text in pieces of at most max_chars characters, each a request of its own: whole paragraphs where
    they fit (short ones merged), else sentences, else words. Every word is kept."""
    out: List[str] = []
    cur = ""
    for p in (s.strip() for s in re.split(r"\n\s*\n", str(text))):
        if not p:
            continue
        for piece in (_split_long(p, max_chars) if len(p) > max_chars else [p]):
            if cur and len(cur) + len(piece) + 2 > max_chars:
                out.append(cur)
                cur = ""
            cur = f"{cur}\n\n{piece}" if cur else piece
    if cur:
        out.append(cur)
    return out


async def in_pieces(text: str, max_chars: int, fn: Callable[[str], Awaitable[Tuple[bytes, List[dict]]]]) -> Tuple[bytes, List[dict]]:
    """Synthesize text piece by piece with fn(piece) → (audio, boundaries), joined into one clip."""
    parts = [await fn(piece) for piece in pieces(text, max_chars)]
    if not parts:
        raise HTTPException(status_code=400, detail="Text is required")
    audio, boundaries, _ = join_pieces(parts)
    return audio, boundaries


# ---- SSML ----
_XML = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}
_CONTROL = re.compile("[\u0000-\u0008\u000B\u000C\u000E-\u001F]")


def escape_xml(s: str) -> str:
    return re.sub(r"[&<>\"']", lambda m: _XML[m.group(0)], str(s))


def clean_text(s: str) -> str:
    """Most C0 control characters (common in OCR'd PDFs) are rejected by the services."""
    return _CONTROL.sub(" ", str(s))


def has_breaks(text: str) -> bool:
    return bool(_BREAK_TAG.search(text))


def _break_ms(n: str, unit: str) -> int:
    return int(round(float(n) * (1000 if unit.lower() == "s" else 1)))


def ssml_body(text: str, max_ms: int = 5000) -> str:
    """Text escaped for SSML, with break tags (from the markup editor, or typed) kept as tags and capped
    at max_ms. Nothing else in the text is read as markup."""
    def repl(m):
        if m.group(1):
            return f'<break time="{min(max_ms, _break_ms(m.group(1), m.group(2)))}ms"/>'
        return _XML[m.group(0)]
    return re.sub(r'<break\s+time="(\d+(?:\.\d+)?)\s*(ms|s)"\s*/>|[&<>"\']', repl, clean_text(text), flags=re.I)


def ssml_with_marks(text: str, max_ms: int = 5000) -> Tuple[str, List[str]]:
    """SSML with a <mark> before every word, for providers that report when a mark is reached (Google).
    Returns the body and the words in mark order (mark names are their indexes)."""
    words: List[str] = []
    body = ""
    for i, part in enumerate(re.split(r'(<break\s+time="\d+(?:\.\d+)?\s*(?:ms|s)"\s*/>)', clean_text(text), flags=re.I)):
        if i % 2:
            body += ssml_body(part, max_ms)
            continue

        def repl(m):
            run = m.group(0)
            if run.isspace():
                return run
            words.append(run)
            return f'<mark name="{len(words) - 1}"/>{escape_xml(run)}'
        body += re.sub(r"\S+|\s+", repl, part)
    return body, words


# ---- HTTP ----
async def fetch(name: str, method: str, url: str, *, headers: Optional[dict] = None, json_body=None, data=None, timeout: int = 60) -> Tuple[int, dict, bytes]:
    """One HTTP call: (status, lower-cased headers, body). Network failures and timeouts become 502/504 naming the provider."""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.request(method, url, headers=headers, json=json_body, data=data) as resp:
                return resp.status, {k.lower(): v for k, v in resp.headers.items()}, await resp.read()
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail=f"{name} error: {exc}")
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail=f"{name} timed out")


def error_body(body: bytes) -> dict:
    """The error body of a failed response as a dict (never a throw)."""
    import json
    try:
        d = json.loads(body)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def locales() -> List[str]:
    """Which locales a provider's voice list should hold: VOICE_LOCALES (comma-separated; "*" for every one),
    default en-US like the Edge list."""
    raw = [s.strip() for s in os.environ.get("VOICE_LOCALES", "en-US").split(",") if s.strip()]
    return [] if "*" in raw else raw


def locale_ok(wanted: Iterable[str], locale: Optional[str]) -> bool:
    wanted = list(wanted)
    return not wanted or any(str(locale or "").lower() == w.lower() for w in wanted)


def title(s: str) -> str:
    return s[:1].upper() + s[1:] if s else ""
