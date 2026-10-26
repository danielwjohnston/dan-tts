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
- **URL text extraction** — paste a URL, load page text for read-aloud (menus, sidebars, boxes and hidden elements dropped; the same rules on the Python server and the Cloudflare Worker)
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

Optional: set `ELEVENLABS_API_KEY` in the environment (and `ELEVENLABS_MODEL`, default `eleven_multilingual_v2`) and the account's ElevenLabs voices join the Edge voices as `eleven:<voice_id>`. `/health` lists the providers in use and `/usage` reports this month's remaining ElevenLabs credits (the tester shows them under the voice picker). The key is only ever read on the server; see `worker/README.md` for the Cloudflare steps and what the free plan allows.

## Usage

Example (mp3):

```bash
curl -X POST http://127.0.0.1:8000/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello world","voice":"en-US-AriaNeural","format":"mp3"}' \
  --output hello.mp3
```

Change `format` to `m4a`, `ogg`, or `flac` (requires ffmpeg). Default voice: `en-US-AriaNeural`.

## HTML tester

Open `tester.html` in a browser, or visit https://dan-tts.macdaddydwj.workers.dev/tester.html. It talks to the
Cloudflare Worker by default (MP3 only); when the page is served by a dan-tts server (the Worker, or
`uvicorn` locally) it uses that server. **Advanced → API Base URL** switches servers, e.g. `http://localhost:8000`
for m4a/ogg/flac.

## Docker (optional)

Build and run:

```bash
docker build -t dan-tts .
docker run --rm -p 8000:8000 dan-tts
```

## Notes

- dan-tts uses Microsoft Edge's Read Aloud service unofficially, the way the edge-tts library does. It is for personal use, is not affiliated with Microsoft, and can stop working at any time. See [`docs/edge-terms-decision.md`](docs/edge-terms-decision.md) for what is and isn't distributed publicly.
- Large inputs: chunk on the client if needed; this simple service streams a single request.

## GitHub Pages

The static front end (`demo.html`, `tester.html`, `static/`, `samples/`) is deployed to GitHub Pages by
`.github/workflows/pages.yml` on every push to `main`. Enable it once under **Settings → Pages → Source: GitHub Actions**.
The site will be at `https://danielwjohnston.github.io/dan-tts/`. Pages is static-only, so synthesis in
`tester.html` goes to the Cloudflare Worker (the default API), or to any server set in "API Base URL".

## Free backend hosting

Two free options: **Cloudflare Workers** (never sleeps, MP3 only, Load from URL included; see [`worker/`](worker/)) or
**Render** (below, sleeps when idle, but has ffmpeg for m4a/ogg/flac).

The Cloudflare deploy is configured by the root `wrangler.jsonc`: one Worker serves the API from `worker/` and the
front end (`demo.html` at `/`, `tester.html`, `static/`, `samples/`) as static assets. Cloudflare's Git builds deploy it
on every push to `main` and preview every other branch; the build step assembles `_site/` and runs `npx wrangler deploy`.

### Render

`render.yaml` deploys the API on Render's free plan using the Dockerfile:

1. Sign in at https://render.com with GitHub (no card needed for the free plan).
2. **New → Blueprint**, pick this repo, and click **Apply**.
3. Copy the service URL (e.g. `https://dan-tts.onrender.com`) into the **API Base URL** box on the GitHub Pages tester.
4. Optional: the service's **Environment** tab → add `ELEVENLABS_API_KEY` to enable ElevenLabs voices.

Free services sleep after ~15 minutes idle; the first request afterwards takes ~30–60s to wake up.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
node --test tests/chunk-text.test.js tests/bundle.test.js   # chunker, zip/SRT
node --test worker/test/*.test.js                           # Cloudflare Worker routes and Load from URL
```

Edge TTS and outbound HTTP are stubbed, so the suites run offline. CI runs it on every PR.

The voice service itself is unofficial, so `.github/workflows/edge-health.yml` checks it every six hours (voice list
and a short synthesis, from Node and through the Worker) and opens a GitHub issue when it stops working:
`node scripts/edge-health.mjs` runs the same check by hand.
