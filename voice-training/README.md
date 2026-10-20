# Voice training tools

Prep tools for recording a personal voice dataset to fine-tune a local TTS model.
Standard library only, so nothing here changes `requirements.txt`.

## 1. Make the recording script

```bash
python voice-training/make_prompts.py my_text.txt -o voice-training/dataset/prompts.txt --shuffle --show-rejected
```

Sentences are drawn from a plain-text file (public-domain books work well). Each line of
the output is `id|sentence`, e.g. `dan_0001|The quick brown fox...`. Sentences that are
too short or long, contain digits or unusual characters, or have no final punctuation
are dropped, and `--show-rejected` lists why.

## 2. Record

Record each sentence as `dataset/wavs/<id>.wav`: 16-bit mono PCM at 22050 Hz. Keep the
same mic, distance and room for the whole session. Aim for roughly 1 to 3 hours of clean
audio.

Once recording is done, write `dataset/metadata.csv` from `prompts.txt` (same lines, same
ids) for the clips you kept.

## 3. Validate

```bash
python voice-training/validate_dataset.py voice-training/dataset
```

Errors (exit code 1): missing or unreadable WAVs, wrong channel count, bit depth or sample
rate, clips over 15 seconds, duplicate or empty entries. Warnings: clipping, very quiet
clips, very short clips, transcripts without final punctuation, WAVs not in metadata.

Run the tests with `python -m pytest tests/test_voice_tools.py`.
