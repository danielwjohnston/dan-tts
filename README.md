# Dan's TTS Project

> **Browser extension:** read any page aloud with word highlighting, no server needed. See [`extension/`](extension/).

Minimal text-to-speech microservice using Microsoft Edge online voices (no API key).
Outputs MP3 directly, can return M4A/OGG/FLAC via ffmpeg transcode.

## Features

- **17 Edge TTS voices** (en-US, no API key required)
- **Formats**: mp3 (direct), m4a, ogg, flac (via ffmpeg)
- **Word-level highlighting** — real-time word tracking during playback
- **Paragraph chunking** — long text is split into paragraphs and generated in sequence with a progress bar; highlighting stays in sync across the whole text
- **Auto-scroll pause** — scroll freely during playback without rubber-banding
- **URL text extraction** — paste a URL, load page text for read-aloud
- **Export** — JSON bundle (audio + timing), WebVTT and SRT captions, a **standalone HTML file** (audio + highlighting player in one file that opens anywhere), or player embed code
- **Batch** — several texts separated by `---` lines become one zip of MP3s with SRT captions
- **Standalone player** (`static/tts-player.js`) — drop on any site for highlighting playback
- **Voice preview** — pre-rendered samples, gender filter tabs, favorites (localStorage)
- **Dark mode**, smart filenames, download, history, Ctrl+Enter shortcut
- Health check at `/health`

## Setup

Requirements: Python 3.9+, `ffmpeg` on PATH (for m4a/ogg/flac), pip.

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

## Usage

Example (mp3):

```bash
curl -X POST http://127.0.0.1:8000/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","voice":"en-US-AriaNeural","format":"mp3"}' \
  --output hello.mp3
```

Change `format` to `m4a`, `ogg`, or `flac` (requires ffmpeg). Default voice: `en-US-AriaNeural`.

## HTML tester (local)

Open `tester.html` in a browser. Set API base to your server (default `http://localhost:8000`).

## Docker (optional)

Build and run:

```bash
docker build -t dan-tts .
docker run --rm -p 8000:8000 dan-tts
```

## Notes

- Edge TTS uses Microsoft online voices; subject to Microsoft availability/changes.
- Large inputs: chunk on the client if needed; this simple service streams a single request.

## GitHub Pages

The static front end (`demo.html`, `tester.html`, `static/`, `samples/`) is deployed to GitHub Pages by
`.github/workflows/pages.yml` on every push to `main`. Enable it once under **Settings → Pages → Source: GitHub Actions**.
The site will be at `https://danielwjohnston.github.io/dan-tts/`. Pages is static-only, so synthesis in
`tester.html` still needs the FastAPI server running somewhere — set the "API Base URL" field to it.

## Cloudflare Workers

`wrangler.jsonc` deploys the same static front end to Cloudflare Workers (static assets only). Its custom
build step assembles `_site/` from `demo.html`, `tester.html`, `static/` and `samples/`, so the Cloudflare
build needs no build command, just the deploy command `npx wrangler deploy`. Cloudflare Workers can't run the
FastAPI server (it shells out to ffmpeg), so point the tester's API Base URL at the Render backend below.

## Free backend hosting (Render)

`render.yaml` deploys the API on Render's free plan using the Dockerfile:

1. Sign in at https://render.com with GitHub (no card needed for the free plan).
2. **New → Blueprint**, pick this repo, and click **Apply**.
3. Copy the service URL (e.g. `https://dan-tts.onrender.com`) into the **API Base URL** box on the GitHub Pages tester.

Free services sleep after ~15 minutes idle; the first request afterwards takes ~30–60s to wake up.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/chunk-text.test.js tests/bundle.test.js   # chunker, zip/SRT
```

Edge TTS and outbound HTTP are stubbed, so the suites run offline. CI runs it on every PR.
