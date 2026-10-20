import base64
import io
import json
import pathlib
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "calibre-plugin"))

import dan_tts_core as core  # noqa: E402


def test_chunk_text_merges_short_paragraphs_and_keeps_limit():
    text = "\n\n".join(f"Paragraph {i} is short." for i in range(200))
    chunks = core.chunk_text(text)
    assert len(chunks) > 1
    assert all(len(chunk) <= core.MAX_CHUNK_CHARS for chunk in chunks)
    assert "Paragraph 0 is short." in chunks[0]
    assert "Paragraph 199 is short." in chunks[-1]


def test_chunk_text_splits_oversized_paragraph_at_sentences():
    sentence = "This is a sentence of moderate length. "
    text = sentence * 300  # one paragraph, far above the limit
    chunks = core.chunk_text(text)
    assert len(chunks) > 1
    assert all(len(chunk) <= core.MAX_CHUNK_CHARS for chunk in chunks)
    assert all(chunk.endswith(".") for chunk in chunks)


def test_chunk_text_hard_splits_run_on_text():
    chunks = core.chunk_text("x" * (core.MAX_CHUNK_CHARS * 2 + 10))
    assert [len(c) for c in chunks] == [core.MAX_CHUNK_CHARS, core.MAX_CHUNK_CHARS, 10]


def test_clean_text_removes_control_characters():
    assert core.clean_text("a\x00b\x0cc") == "a b c"


def test_html_to_text_skips_scripts_and_keeps_paragraphs():
    markup = "<html><head><title>T</title></head><body><script>x()</script><p>One\n two</p><p>Two</p></body></html>"
    assert core.html_to_text(markup) == "One two\n\nTwo"


def _make_epub(path, spine_order):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("META-INF/container.xml", """<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""")
        manifest = "".join(
            f'<item id="{name}" href="{name}.xhtml" media-type="application/xhtml+xml"/>'
            for name in ("ch1", "ch2", "ch3")
        )
        spine = "".join(f'<itemref idref="{name}"/>' for name in spine_order)
        archive.writestr("OEBPS/content.opf", f"""<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>{manifest}</manifest>
  <spine>{spine}</spine>
</package>""")
        for name in ("ch1", "ch2", "ch3"):
            archive.writestr(f"OEBPS/{name}.xhtml", f"<html><body><p>Text of {name}.</p></body></html>")
    path.write_bytes(buffer.getvalue())
    return path


def test_epub_text_follows_spine_order(tmp_path):
    epub = _make_epub(tmp_path / "book.epub", spine_order=["ch3", "ch1", "ch2"])
    assert core.epub_text(epub) == "Text of ch3.\n\nText of ch1.\n\nText of ch2."


def test_extract_text_rejects_unsupported_format(tmp_path):
    with pytest.raises(core.UnsupportedFormat):
        core.extract_text(tmp_path / "book.mobi", "MOBI")


def test_srt_time_formats_hours_minutes_seconds_millis():
    ticks = (3_600_000 + 60_000 + 1_234) * core.TICKS_PER_MS
    assert core.srt_time(ticks) == "01:01:01,234"


def test_mp3_ticks_matches_48kbps():
    # One second of 48 kbps audio is 6000 bytes.
    assert core.mp3_ticks(6000) == core.TICKS_PER_SECOND


def test_srt_from_words_groups_words_into_cues():
    words = [{"start": i * 1000 * core.TICKS_PER_MS, "duration": 500 * core.TICKS_PER_MS, "text": f"w{i}"} for i in range(10)]
    srt = core.srt_from_words(words)
    assert srt.count(" --> ") == 2
    assert "w0 w1 w2 w3 w4 w5 w6 w7" in srt


class _StubServer(BaseHTTPRequestHandler):
    """Answers /synthesize_with_timing with fixed audio and one boundary per word."""

    audio = b"\x00" * 6000  # exactly one second at 48 kbps

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        words = body["text"].split()
        boundaries = [
            {"offset": i * 10_000_000 // 4, "duration": 2_500_000, "text": word}
            for i, word in enumerate(words)
        ]
        reply = json.dumps({
            "audio": base64.b64encode(self.audio).decode("ascii"),
            "contentType": "audio/mpeg",
            "format": "mp3",
            "boundaries": boundaries,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)

    def log_message(self, *args):
        pass


@pytest.fixture
def stub_server():
    server = HTTPServer(("127.0.0.1", 0), _StubServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def test_make_audiobook_joins_audio_and_shifts_timings(stub_server, monkeypatch):
    # Two chunks: the first is "alpha beta", the second is a long run of "gamma" words.
    text = "alpha beta\n\n" + ("gamma " * 210)  # 1260 chars: too big to merge with the first paragraph
    captured = {}

    def capture_words(words):
        captured["words"] = words
        return ""

    monkeypatch.setattr(core, "srt_from_words", capture_words)
    progress = []
    mp3, _ = core.make_audiobook(stub_server, text, "en-US-AriaNeural", on_progress=lambda d, t: progress.append((d, t)))

    assert progress[-1] == (2, 2)
    assert len(mp3) == 6000 * 2  # two chunks, one second of audio each
    words = captured["words"]
    assert [w["text"] for w in words[:2]] == ["alpha", "beta"]
    # The second chunk's first word starts after the first chunk's one second of audio.
    first_gamma = next(w for w in words if w["text"] == "gamma")
    assert first_gamma["start"] == core.TICKS_PER_SECOND


def test_make_audiobook_rejects_empty_text(stub_server):
    with pytest.raises(ValueError):
        core.make_audiobook(stub_server, "   \n\n  ", "en-US-AriaNeural")
