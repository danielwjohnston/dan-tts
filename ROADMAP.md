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

## Longer-Term / Experimental

- **Video generation** — Use ffmpeg to create MP4 videos with synchronized text highlighting (multiple styles: typewriter, split-screen, animated slides)
- ~~**Deployment**~~ — Done: GitHub Pages (front end) + Render free plan (API)
- **CMS integrations** — WordPress shortcode, Ghost embed, static site generator plugins
- **Multi-language support** — Expand beyond en-US voices
- **Custom voice profiles** — Save per-project voice + speed + format preferences
