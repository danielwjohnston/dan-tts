# Dan's TTS Project

Minimal text-to-speech microservice using Microsoft Edge online voices (no API key).
Outputs MP3 directly, can return M4A/OGG/FLAC via ffmpeg transcode.

## Features

- Edge TTS (no key), configurable voice
- Formats: mp3 (direct), m4a, ogg, flac (via ffmpeg)
- Simple FastAPI service with CORS open for local testing
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
