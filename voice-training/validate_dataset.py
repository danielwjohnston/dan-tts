"""Check a recorded voice dataset before spending GPU time on training.

    python voice-training/validate_dataset.py voice-training/dataset

Expects an LJSpeech-style layout:
    dataset/metadata.csv     one `id|transcript` line per clip, no header
    dataset/wavs/<id>.wav    16-bit mono PCM at the target sample rate

Exits 1 if any error is found. Warnings are reported but do not fail the run.
Standard library only.
"""
import argparse
import array
import sys
import wave
from pathlib import Path

FULL_SCALE = 32767


def load_rows(metadata: Path, errors: list):
    rows = []
    for number, line in enumerate(metadata.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        if "|" not in line:
            errors.append(f"metadata.csv line {number}: missing '|' separator")
            continue
        clip_id, text = line.split("|", 1)
        rows.append((number, clip_id.strip(), text.strip()))
    return rows


def check_wav(path: Path, sample_rate: int, min_sec: float, max_sec: float, errors: list, warnings: list):
    """Return the clip duration in seconds, or None if the file is unusable."""
    try:
        with wave.open(str(path), "rb") as wav:
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            rate = wav.getframerate()
            frames = wav.getnframes()
            samples = array.array("h")
            if width == 2 and channels == 1:
                samples.frombytes(wav.readframes(frames))
    except (wave.Error, EOFError, OSError) as exc:
        errors.append(f"{path.name}: unreadable WAV ({exc})")
        return None

    if channels != 1:
        errors.append(f"{path.name}: {channels} channels, need mono")
    if width != 2:
        errors.append(f"{path.name}: {width * 8}-bit, need 16-bit PCM")
    if rate != sample_rate:
        errors.append(f"{path.name}: {rate} Hz, need {sample_rate} Hz")
    if channels != 1 or width != 2 or rate != sample_rate:
        return None

    duration = frames / rate
    if duration < min_sec:
        warnings.append(f"{path.name}: {duration:.2f}s, shorter than {min_sec}s")
    elif duration > max_sec:
        errors.append(f"{path.name}: {duration:.2f}s, longer than {max_sec}s (split it)")

    if samples:
        peak = max(abs(s) for s in samples)
        if peak >= FULL_SCALE - 1:
            warnings.append(f"{path.name}: clipping (peak at full scale)")
        elif peak < FULL_SCALE * 0.05:
            warnings.append(f"{path.name}: very quiet (peak {peak / FULL_SCALE:.1%} of full scale)")
    return duration


def validate(dataset: Path, *, sample_rate=22050, min_sec=1.0, max_sec=15.0):
    """Return (errors, warnings, summary) for a dataset directory."""
    errors, warnings = [], []
    metadata = dataset / "metadata.csv"
    wav_dir = dataset / "wavs"
    if not metadata.exists():
        return [f"missing {metadata}"], [], {}
    if not wav_dir.is_dir():
        return [f"missing {wav_dir}/"], [], {}

    rows = load_rows(metadata, errors)
    seen_ids = set()
    referenced = set()
    total_sec = 0.0
    checked = 0

    for number, clip_id, text in rows:
        if not clip_id:
            errors.append(f"metadata.csv line {number}: empty id")
            continue
        if clip_id in seen_ids:
            errors.append(f"metadata.csv line {number}: duplicate id {clip_id}")
            continue
        seen_ids.add(clip_id)
        if not text:
            errors.append(f"{clip_id}: empty transcript")
            continue
        if text[-1] not in ".!?":
            warnings.append(f"{clip_id}: transcript has no final punctuation")

        wav_path = wav_dir / f"{clip_id}.wav"
        referenced.add(wav_path.name)
        if not wav_path.exists():
            errors.append(f"{clip_id}: missing {wav_path.name}")
            continue
        duration = check_wav(wav_path, sample_rate, min_sec, max_sec, errors, warnings)
        if duration is not None:
            total_sec += duration
            checked += 1

    for extra in sorted(p.name for p in wav_dir.glob("*.wav")):
        if extra not in referenced:
            warnings.append(f"{extra}: not listed in metadata.csv")

    summary = {
        "clips": len(rows),
        "checked": checked,
        "minutes": total_sec / 60,
    }
    return errors, warnings, summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--sample-rate", type=int, default=22050)
    parser.add_argument("--min-sec", type=float, default=1.0)
    parser.add_argument("--max-sec", type=float, default=15.0)
    args = parser.parse_args(argv)

    errors, warnings, summary = validate(
        args.dataset, sample_rate=args.sample_rate, min_sec=args.min_sec, max_sec=args.max_sec
    )
    for message in warnings:
        print(f"warning: {message}")
    for message in errors:
        print(f"error:   {message}")
    if summary:
        print(
            f"\n{summary['checked']}/{summary['clips']} clips checked, "
            f"{summary['minutes']:.1f} minutes of audio, "
            f"{len(errors)} error(s), {len(warnings)} warning(s)"
        )
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
