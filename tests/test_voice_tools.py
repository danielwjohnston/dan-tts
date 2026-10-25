import array
import math
import sys
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "voice-training"))

from make_prompts import build_prompts, main as prompts_main  # noqa: E402
from validate_dataset import main as validate_main, validate  # noqa: E402

RATE = 22050


def write_wav(path: Path, seconds=2.0, amplitude=0.5, channels=1, width=2, rate=RATE):
    path.parent.mkdir(parents=True, exist_ok=True)
    n = int(seconds * rate) * channels
    peak = int(32767 * amplitude)
    samples = array.array("h", (int(peak * math.sin(i / 10)) for i in range(n)))
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(width)
        wav.setframerate(rate)
        wav.writeframes(samples.tobytes() if width == 2 else bytes(n * width))


def make_dataset(root: Path, rows):
    """rows: list of (id, transcript). Writes metadata.csv and a valid wav per row."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "metadata.csv").write_text("".join(f"{i}|{t}\n" for i, t in rows), encoding="utf-8")
    for clip_id, _ in rows:
        write_wav(root / "wavs" / f"{clip_id}.wav")
    return root


# --- make_prompts ---------------------------------------------------------

def test_splits_sentences_and_numbers_ids():
    rows, rejected = build_prompts("The quick brown fox jumps over the lazy dog. A second sentence here today!")
    assert [r[0] for r in rows] == ["dan_0001", "dan_0002"]
    assert rows[0][1] == "The quick brown fox jumps over the lazy dog."
    assert rejected == []


def test_rejects_bad_sentences_with_reasons():
    text = (
        "Visit example.com for 3 more details now.\n\n"
        "Too short here.\n\n"
        "The quick brown fox jumps over the lazy dog\n\n"
        "The quick brown fox jumps over the lazy dog."
    )
    rows, rejected = build_prompts(text)
    reasons = {sentence: reason for sentence, reason in rejected}
    assert "digits (spell numbers out)" in reasons["Visit example.com for 3 more details now."]
    assert reasons["Too short here."].startswith("too short")
    assert reasons["The quick brown fox jumps over the lazy dog"] == "no final punctuation"
    assert len(rows) == 1


def test_dedupes_case_insensitively_and_normalizes_quotes():
    text = "It’s a fine day outside today. it’s a fine day outside today."
    rows, rejected = build_prompts(text)
    assert len(rows) == 1
    assert rows[0][1] == "It's a fine day outside today."
    assert rejected[0][1] == "duplicate"


def test_shuffle_is_seeded_and_reproducible():
    text = "\n\n".join(f"Sentence number {i} is written in a plain way." for i in range(20))
    a, _ = build_prompts(text, shuffle=True, seed=7)
    b, _ = build_prompts(text, shuffle=True, seed=7)
    assert a == b


def test_prompts_cli_writes_metadata_shape(tmp_path):
    src = tmp_path / "src.txt"
    src.write_text("The quick brown fox jumps over the lazy dog. Another useful sentence follows.", encoding="utf-8")
    out = tmp_path / "out" / "prompts.txt"
    assert prompts_main([str(src), "-o", str(out)]) == 0
    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("dan_0001|")
    assert all("|" in line for line in lines)


def test_prompts_cli_fails_when_nothing_usable(tmp_path):
    src = tmp_path / "src.txt"
    src.write_text("Too short.", encoding="utf-8")
    assert prompts_main([str(src), "-o", str(tmp_path / "p.txt")]) == 1


# --- validate_dataset -----------------------------------------------------

def test_valid_dataset_passes(tmp_path):
    ds = make_dataset(tmp_path / "ds", [("dan_0001", "A good sentence here."), ("dan_0002", "Another good one.")])
    errors, warnings, summary = validate(ds)
    assert errors == []
    assert warnings == []
    assert summary["checked"] == 2
    assert validate_main([str(ds)]) == 0


def test_flags_missing_wav_duplicate_id_and_empty_transcript(tmp_path):
    ds = make_dataset(tmp_path / "ds", [("dan_0001", "Good one here."), ("dan_0002", "Second one here.")])
    (ds / "wavs" / "dan_0002.wav").unlink()
    with open(ds / "metadata.csv", "a", encoding="utf-8") as f:
        f.write("dan_0001|Duplicate id here.\n")
        f.write("dan_0003|\n")
    errors, _, _ = validate(ds)
    text = "\n".join(errors)
    assert "dan_0002: missing dan_0002.wav" in text
    assert "duplicate id dan_0001" in text
    assert "dan_0003: empty transcript" in text
    assert validate_main([str(ds)]) == 1


def test_flags_wrong_format_and_length(tmp_path):
    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "metadata.csv").write_text("stereo|Stereo clip here.\nrate|Wrong rate here.\nlong|Long clip here.\n", encoding="utf-8")
    write_wav(ds / "wavs" / "stereo.wav", channels=2)
    write_wav(ds / "wavs" / "rate.wav", rate=16000)
    write_wav(ds / "wavs" / "long.wav", seconds=20.0)
    errors, _, _ = validate(ds)
    text = "\n".join(errors)
    assert "stereo.wav: 2 channels" in text
    assert "rate.wav: 16000 Hz" in text
    assert "long.wav" in text and "longer than" in text


def test_warns_on_clipping_quiet_and_unlisted_files(tmp_path):
    ds = tmp_path / "ds"
    ds.mkdir()
    (ds / "metadata.csv").write_text("loud|Loud clip here.\nquiet|Quiet clip here.\n", encoding="utf-8")
    write_wav(ds / "wavs" / "loud.wav", amplitude=1.0)
    write_wav(ds / "wavs" / "quiet.wav", amplitude=0.01)
    write_wav(ds / "wavs" / "orphan.wav")
    errors, warnings, _ = validate(ds)
    text = "\n".join(warnings)
    assert errors == []
    assert "loud.wav: clipping" in text
    assert "quiet.wav: very quiet" in text
    assert "orphan.wav: not listed" in text


def test_missing_metadata_is_an_error(tmp_path):
    (tmp_path / "ds").mkdir()
    errors, _, _ = validate(tmp_path / "ds")
    assert errors and "metadata.csv" in errors[0]
