# dan-tts on Cloudflare Workers (free)

The site and the API in one Worker on Cloudflare's free plan, at **https://dan-tts.macdaddydwj.workers.dev**. Unlike Render's free plan it **never sleeps** (no one-minute wake-up), and it allows about 100,000 requests a day. The tester uses it by default.

| Endpoint | On the Worker |
|---|---|
| `GET /` (demo), `/tester.html`, `/static/…` | ✅ Same files as GitHub Pages |
| `GET /health`, `GET /voices`, `GET /samples/{voice}` | ✅ (voices and samples are cached) |
| `POST /synthesize`, `POST /synthesize_with_timing` | ✅ MP3 only |
| `POST /export?format=json\|webvtt\|srt` | ✅ |
| `POST /extract_text` (Load from URL) | ✅ Reads `<main>`/`<article>`, drops menus, sidebars and boxes; 5 MB and 15 s limits |

Speech was verified on the deployed Worker on 2026-10-25: Microsoft's voice service accepts connections from Cloudflare's servers (a 7-word synthesis returned a real MP3 with word timings).

Non-MP3 formats (m4a, ogg, flac) need ffmpeg, which only the Python server has; the tester greys them out when it talks to the Worker.

## How it deploys

Cloudflare's **Git builds** are connected to this repository (dashboard → Workers & Pages → dan-tts → Settings → Build). Every push to `main` builds and deploys from the root [`wrangler.jsonc`](../wrangler.jsonc): its build command assembles `_site/` (the static front end) and `npx wrangler deploy` uploads that plus the API in `worker/src/`. Other branches get a **preview** at `https://<branch-with-dashes>-dan-tts.macdaddydwj.workers.dev`, linked from the Cloudflare bot's comment on each pull request. There is nothing to configure in GitHub, no API token and no secrets.

**Skip the Python install.** The build image sees `requirements.txt` at the repo root and runs `pip install` (about 10 s) even though the Worker doesn't use it. To turn that off: dashboard → the Worker → **Settings → Build → Build variables**, add `SKIP_DEPENDENCY_INSTALL` = `1`. The build command runs `npx wrangler deploy`, which downloads wrangler itself, so nothing else is needed. (Cloudflare documents the variable under [Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).)

To deploy from a computer instead: `npm install` in `worker/`, then `npx wrangler login` and `npm run deploy` (which runs `wrangler deploy` from the repo root). Deploying from inside `worker/` with its own `wrangler.toml` would publish the API without the site.

## Local development

```bash
cd worker
npm install
npx wrangler dev        # http://127.0.0.1:8787, API only
```

The Worker imports the shared engine from `../engine/src`, so there's nothing to copy or sync. `src/extract.js` is the Load from URL implementation (a small HTML tokenizer, since there is no DOM in a Worker); the Python server's `/extract_text` in `app/main.py` follows the same rules, so change both together. Tests: `node --test worker/test/*.test.js` (offline; CI runs them).

## Limits
- The free plan limits CPU time per request (Cloudflare's limits change, so check their docs). Waiting on Microsoft doesn't count toward it. Requests are capped at 20,000 characters, and the tester splits long text into paragraphs anyway.
- Load from URL can't reach sites that block automated access (it says so, with an "Open in browser" link), and pages built entirely in JavaScript give only their description. The browser extension reads such pages in place.
- The engine depends on an unofficial endpoint and a token scheme pinned in `engine/src/drm.js`. A scheduled GitHub Actions job ([`edge-health.yml`](../.github/workflows/edge-health.yml)) checks the voice list and a short synthesis every six hours, straight from Node and through this Worker, and opens an issue when it fails.
