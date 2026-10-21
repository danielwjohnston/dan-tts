"""Turn plain text into a numbered recording script for a voice dataset.

    python voice-training/make_prompts.py source.txt -o voice-training/dataset/prompts.txt

Output is `id|sentence` per line, the same shape as an LJSpeech metadata.csv, so
each recorded clip named <id>.wav lines up with its row once you finish recording.
Standard library only.
"""
import argparse
import random
import re
import sys
from pathlib import Path

# Letters, digits, spaces and basic punctuation. Anything else (URLs, emoji, symbols,
# unusual Unicode) is rejected so the recording script stays pronounceable.
ALLOWED = re.compile(r"^[A-Za-z0-9 ,.;:!?'\"()\-]+$")
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
CURLY = {"‘": "'", "’": "'", "“": '"', "”": '"', "—": " - ", "–": " - "}


def normalize(text: str) -> str:
    for src, dst in CURLY.items():
        text = text.replace(src, dst)
    return re.sub(r"\s+", " ", text).strip()


def split_sentences(text: str):
    for paragraph in re.split(r"\n\s*\n", text):
        for sentence in SENTENCE_END.split(normalize(paragraph)):
            if sentence:
                yield sentence


def reject_reason(sentence: str, min_words: int, max_words: int):
    """Return why a sentence is unsuitable, or None if it is good."""
    if not ALLOWED.match(sentence):
        return "unsupported characters"
    if re.search(r"\d", sentence):
        return "digits (spell numbers out)"
    words = len(sentence.split())
    if words < min_words:
        return f"too short ({words} words)"
    if words > max_words:
        return f"too long ({words} words)"
    if sentence[-1] not in ".!?":
        return "no final punctuation"
    return None


def build_prompts(text: str, *, min_words=4, max_words=25, prefix="dan", shuffle=False, seed=0):
    """Return (rows, rejected) where rows is a list of (id, sentence)."""
    seen = set()
    kept, rejected = [], []
    for sentence in split_sentences(text):
        key = sentence.lower()
        if key in seen:
            rejected.append((sentence, "duplicate"))
            continue
        seen.add(key)
        reason = reject_reason(sentence, min_words, max_words)
        if reason:
            rejected.append((sentence, reason))
        else:
            kept.append(sentence)
    if shuffle:
        random.Random(seed).shuffle(kept)
    rows = [(f"{prefix}_{i:04d}", s) for i, s in enumerate(kept, start=1)]
    return rows, rejected


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="plain-text file to draw sentences from")
    parser.add_argument("-o", "--output", type=Path, required=True, help="where to write id|sentence lines")
    parser.add_argument("--min-words", type=int, default=4)
    parser.add_argument("--max-words", type=int, default=25)
    parser.add_argument("--prefix", default="dan", help="id prefix, e.g. dan -> dan_0001")
    parser.add_argument("--shuffle", action="store_true", help="randomize order (seeded)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--show-rejected", action="store_true", help="print rejected sentences and reasons")
    args = parser.parse_args(argv)

    rows, rejected = build_prompts(
        args.source.read_text(encoding="utf-8"),
        min_words=args.min_words,
        max_words=args.max_words,
        prefix=args.prefix,
        shuffle=args.shuffle,
        seed=args.seed,
    )
    if not rows:
        print("No usable sentences found.", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("".join(f"{i}|{s}\n" for i, s in rows), encoding="utf-8")

    total_words = sum(len(s.split()) for _, s in rows)
    print(f"Wrote {len(rows)} prompts (~{total_words} words) to {args.output}")
    print(f"Rejected {len(rejected)} sentences")
    if args.show_rejected:
        for sentence, reason in rejected:
            print(f"  [{reason}] {sentence}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
