# Dan-TTS Roadmap

Future feature ideas, roughly prioritized. Nothing here is committed — just documented for reference.

## Near-Term

- ~~**SRT caption export**~~ — Done
- ~~**Paragraph chunking**~~ — Done: long text is split into paragraphs and synthesized in sequence with a progress bar
- ~~**Batch synthesis**~~ — Done: tester's Batch panel turns `---`-separated texts into one zip of MP3s + SRT captions
- ~~**Improved embed workflow**~~ — Done: Export → Standalone HTML is one file with audio, timings and player inlined

## Medium-Term

- **SSML support** — Allow fine-grained control over pronunciation, pauses, emphasis, and speaking rate
- ~~**Browser extension**~~ — Done: `extension/` reads pages and selections with no server (Chromium browsers; Firefox next)
- **Voice comparison** — Synthesize same text with multiple voices side-by-side for easy A/B testing
- **Persistent history** — Save synthesis history to localStorage or a lightweight database instead of session-only
  - Extension side done: the library remembers every page read, with resume position

## Voice Training (in-house voice, PR #18)

Prep tools exist (`voice-training/`). Everything below is open. Ordered by what unblocks the next step.

**Blocked on a decision**
- **Consent wording and legal review.** The recording page's consent text is a DRAFT. Get it reviewed for every region it may reach. Current text says permission is irrevocable once recordings are used for training.
- **Recording storage and upload.** Preferred direction: process clips live and discard the audio. Needs an endpoint in `app/` that extracts training features, stores only those, and deletes the audio.
- **Country gate.** `BLOCKED_COUNTRIES` in `voice-training/collect/index.html` is empty and the country is self-reported. Fill it in once the legal review is done.
- **Single voice vs. multi-speaker.** A pilot of a single contributor's voice is simpler and is the recommended first step. Multi-speaker needs far more data and more compute.
- **Hosting.** Decide whether the recording page goes to GitHub Pages or stays private.

**Needs hardware or a real run**
- **Run `voice-training/train.sh` on a GPU machine** against a real Piper checkout. Only the validation stage has been dry-run. Check the Python version, PyTorch/CUDA install, checkpoint download, and a real epoch count (the script uses 100 as a placeholder).
- **Test the recording page with a real microphone.** Check that browser recording and the 22050 Hz WAV conversion work, and that the multi-file download isn't blocked by the browser.
- **Pilot with 5–10 volunteers.** Each reads a few dozen sentences. Use it to check recording quality, the consent flow, and whether the model learns usable speech before scaling.

**Needs investigation**
- **Word timings for highlighting.** Check whether Piper's per-phoneme durations can drive word-level highlighting, or whether a forced aligner is needed.
- **Licensing.** Piper's current code is GPL-3.0-or-later and depends on eSpeak-ng. Confirm what that means before shipping anything built on it.
- **Licensed corpora as a starting point.** Evaluate public speech datasets (e.g. LJSpeech, LibriTTS) and their licenses as a way to train without new recruitment.

**Later**
- **Provider abstraction.** Add a provider layer in `engine/src/` and `app/main.py` so a trained Piper voice sits alongside Edge and the hosted options.
- **Hosted alternatives** (Polly, Google Cloud TTS) as fallbacks if Edge's unofficial endpoint breaks.

## Longer-Term / Experimental

- ~~**PDF reading**~~ — Done in the extension for PDFs with a text layer (headers, footers and page numbers stripped, hyphenation rejoined). Next: text recognition for scanned/image-only PDFs
- **Video generation** — Use ffmpeg to create MP4 videos with synchronized text highlighting (multiple styles: typewriter, split-screen, animated slides)
- ~~**Deployment**~~ — Done: GitHub Pages (front end) + Render free plan (API)
- **CMS integrations** — WordPress shortcode, Ghost embed, static site generator plugins
- **Multi-language support** — Expand beyond en-US voices
- **Custom voice profiles** — Save per-project voice + speed + format preferences
