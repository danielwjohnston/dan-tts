"""Calibre-free core for the dan-tts Calibre plugin.

Reads a book's text (TXT or EPUB), splits it into chunks the server accepts,
synthesizes each chunk through a dan-tts server, and joins the MP3 parts and
word timings into one MP3 plus an SRT file. Standard library only, so the
tests run under plain pytest without Calibre installed.
"""

import base64
import json
import posixpath
import re
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from html.parser import HTMLParser

MAX_CHUNK_CHARS = 3000
MERGE_CHARS = 1200
WORDS_PER_CUE = 8
MP3_BITRATE_BPS = 48_000
TICKS_PER_SECOND = 10_000_000
TICKS_PER_MS = 10_000

SUPPORTED_FORMATS = ("EPUB", "TXT")

_CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_BLANK_LINE = re.compile(r"\n\s*\n")
_BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figure",
    "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "p", "pre", "section",
    "table", "td", "th", "tr", "ul", "ol",
}
_SKIP_TAGS = {"head", "script", "style"}


class UnsupportedFormat(ValueError):
    pass


def clean_text(text):
    """The server rejects most C0 control characters, which OCR and some EPUBs contain."""
    return _CONTROL_CHARS.sub(" ", text)


def chunk_text(text):
    """Split into paragraph-based chunks: short paragraphs merge up to MERGE_CHARS,
    and any chunk stays within MAX_CHUNK_CHARS (the server's per-request limit)."""
    paragraphs = [p.strip() for p in _BLANK_LINE.split(text) if p.strip()]
    chunks, current = [], ""
    for paragraph in paragraphs:
        for piece in _split_long(paragraph):
            if current and len(current) + len(piece) + 2 > MERGE_CHARS:
                chunks.append(current)
                current = piece
            else:
                current = f"{current}\n\n{piece}" if current else piece
    if current:
        chunks.append(current)
    return chunks


def _split_long(paragraph):
    if len(paragraph) <= MAX_CHUNK_CHARS:
        return [paragraph]
    pieces, current = [], ""
    for sentence in _SENTENCE_END.split(paragraph):
        while len(sentence) > MAX_CHUNK_CHARS:
            # A run-on sentence with no break point: cut it at the limit.
            if current:
                pieces.append(current)
                current = ""
            pieces.append(sentence[:MAX_CHUNK_CHARS])
            sentence = sentence[MAX_CHUNK_CHARS:]
        if current and len(current) + len(sentence) + 1 > MAX_CHUNK_CHARS:
            pieces.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        pieces.append(current)
    return pieces


class _TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self.skip_depth += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n\n")

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS:
            self.skip_depth = max(0, self.skip_depth - 1)
        elif tag in _BLOCK_TAGS:
            self.parts.append("\n\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.parts.append(re.sub(r"\s+", " ", data))


def html_to_text(markup):
    parser = _TextParser()
    parser.feed(markup)
    parser.close()
    text = "".join(parser.parts)
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def epub_text(path):
    """Text of an EPUB in spine (reading) order."""
    container_ns = "{urn:oasis:names:tc:opendocument:xmlns:container}"
    opf_ns = {"opf": "http://www.idpf.org/2007/opf"}
    with zipfile.ZipFile(path) as archive:
        container = ET.fromstring(archive.read("META-INF/container.xml"))
        rootfile = container.find(f".//{container_ns}rootfile").get("full-path")
        package = ET.fromstring(archive.read(rootfile))
        base = posixpath.dirname(rootfile)
        manifest = {item.get("id"): item.get("href") for item in package.findall("opf:manifest/opf:item", opf_ns)}
        parts = []
        for itemref in package.findall("opf:spine/opf:itemref", opf_ns):
            href = manifest.get(itemref.get("idref"))
            if not href:
                continue
            name = posixpath.normpath(posixpath.join(base, href))
            parts.append(html_to_text(archive.read(name).decode("utf-8", "replace")))
    return "\n\n".join(part for part in parts if part)


def extract_text(path, fmt):
    fmt = fmt.upper()
    if fmt == "EPUB":
        return epub_text(path)
    if fmt == "TXT":
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    raise UnsupportedFormat(f"Format {fmt} is not supported yet; use EPUB or TXT")


def synthesize_chunk(server_url, text, voice):
    """POST one chunk to /synthesize_with_timing. Returns (mp3 bytes, word boundaries)."""
    body = json.dumps({"text": text, "voice": voice, "format": "mp3"}).encode("utf-8")
    request = urllib.request.Request(
        server_url.rstrip("/") + "/synthesize_with_timing",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        payload = json.load(response)
    return base64.b64decode(payload["audio"]), payload["boundaries"]


def mp3_ticks(byte_count):
    """Duration of a 48 kbps CBR MP3 in 100 ns ticks, the unit the server reports timings in."""
    return byte_count * 8 * TICKS_PER_SECOND // MP3_BITRATE_BPS


def srt_time(ticks):
    ms = ticks // TICKS_PER_MS
    hours, rest = divmod(ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def srt_from_words(words):
    """Group word timings into cues of WORDS_PER_CUE words. Each word is {start, duration, text}."""
    lines = []
    for index, first in enumerate(range(0, len(words), WORDS_PER_CUE), 1):
        group = words[first:first + WORDS_PER_CUE]
        begin = group[0]["start"]
        end = group[-1]["start"] + group[-1]["duration"]
        lines += [str(index), f"{srt_time(begin)} --> {srt_time(end)}", " ".join(w["text"] for w in group), ""]
    return "\n".join(lines)


def make_audiobook(server_url, text, voice, on_progress=None):
    """Synthesize the whole text. Returns (mp3 bytes, SRT text)."""
    chunks = chunk_text(clean_text(text))
    if not chunks:
        raise ValueError("The book has no readable text")
    audio_parts, words, offset = [], [], 0
    for done, chunk in enumerate(chunks, 1):
        audio, boundaries = synthesize_chunk(server_url, chunk, voice)
        audio_parts.append(audio)
        words += [
            {"start": offset + b["offset"], "duration": b["duration"], "text": b["text"]}
            for b in boundaries
        ]
        offset += mp3_ticks(len(audio))
        if on_progress:
            on_progress(done, len(chunks))
    return b"".join(audio_parts), srt_from_words(words)
