# Dan-TTS Roadmap

Future feature ideas, roughly prioritized. Nothing here is committed — just documented for reference.

## Near-Term

- **SRT caption export** — Add SRT format alongside existing WebVTT
- **Paragraph chunking** — Split long text into paragraphs, synthesize sequentially with progress indicator
- **Batch synthesis** — Queue multiple texts, download as zip
- **Improved embed workflow** — Export a self-contained HTML file (audio + player + timing in one file) instead of requiring 3 separate files

## Medium-Term

- **SSML support** — Allow fine-grained control over pronunciation, pauses, emphasis, and speaking rate
- **Bookmarklet / browser extension** — Select text on any page → send to dan-tts for instant read-aloud
- **Voice comparison** — Synthesize same text with multiple voices side-by-side for easy A/B testing
- **Persistent history** — Save synthesis history to localStorage or a lightweight database instead of session-only

## Longer-Term / Experimental

- **Video generation** — Use ffmpeg to create MP4 videos with synchronized text highlighting (multiple styles: typewriter, split-screen, animated slides)
- **Deployment** — Host on Railway, Fly.io, or similar so it's always accessible without running locally
- **CMS integrations** — WordPress shortcode, Ghost embed, static site generator plugins
- **Multi-language support** — Expand beyond en-US voices
- **Custom voice profiles** — Save per-project voice + speed + format preferences
