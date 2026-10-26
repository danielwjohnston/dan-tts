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

## Voice providers: adding ElevenLabs

Edge voices work with no setup. ElevenLabs voices appear as soon as the Worker has an API key; the key stays on the server and is never sent to the browser.

1. Get a key at elevenlabs.io → your profile → **API keys** → Create. The free plan gives 10,000 credits a month (about 10 minutes of speech) for non-commercial use with attribution; the number is on the Subscription page.
2. Cloudflare dashboard → Workers & Pages → **dan-tts** → **Settings** → **Variables and Secrets** → **Add**. Type **Secret**, name `ELEVENLABS_API_KEY`, paste the key as the value, **Deploy**. A secret is hidden after saving; a plain variable is not, so pick Secret.
3. Optional: a second entry `ELEVENLABS_MODEL`, also as type Secret, for example `eleven_turbo_v2_5` for faster, cheaper speech. The default is `eleven_multilingual_v2`. (A plain Text variable added in the dashboard is removed by the next Git deploy; secrets stay.)
4. Check: `https://dan-tts.macdaddydwj.workers.dev/health` now says `"providers":["edge","elevenlabs"]`, and the tester lists the account's voices under "ElevenLabs voices", each with a free preview clip.

Two things that look right but are not. A **Build variable** (Settings → Build) is only visible while the code is being built, never to the running Worker, so the key must be under **Variables and Secrets**. And branch **previews** do not inherit production settings: on the same Variables and Secrets section, switch the toggle from **Production** to **Previews Base** and add the secret there too (secrets must be re-entered by hand). That covers previews created afterwards; a preview that already exists needs the secret set on it directly (Workers & Pages → dan-tts → Previews → the branch → Settings, or `npx wrangler preview secret put ELEVENLABS_API_KEY --name <preview>`). Cloudflare's notes: [Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/).

`/usage` reports the month's remaining credits (the tester shows them under the voice picker, and the health check logs them). Voice ids are `eleven:<voice_id>`, so a request with such a voice goes to ElevenLabs and anything else goes to Edge. Each request is limited to 5,000 characters (the tester splits long text into paragraphs anyway). When the month's credits are gone the server answers 429 with a plain message and Edge voices keep working. Locally, put `ELEVENLABS_API_KEY=...` in `worker/.dev.vars` (ignored by git) and `wrangler dev` picks it up.

## Voice providers: adding Speechify

Speechify voices work the same way: they appear as `speechify:<voice_id>` as soon as the Worker has an API key, and the key stays on the server.

1. Get a key in the Speechify console (an `sk_...` key). Speechify bills per spoken character; SSML tags are not counted.
2. Cloudflare dashboard → Workers & Pages → **dan-tts** → **Settings** → **Variables and Secrets** → **Add**. Type **Secret**, name `SPEECHIFY_API_KEY`, paste the key, **Deploy**. Production already has this secret; add it under **Previews Base** too if previews should speak with Speechify voices.
3. Optional secrets: `SPEECHIFY_MODEL` (default `simba-3.5`, the model Speechify recommends; `simba-3.2` is English only and `simba-3.0` covers six languages; `simba-english` and `simba-multilingual` are retired and answer `400 model_retired`), `SPEECHIFY_LANGUAGE` (an ISO code such as `fr-FR`, sent with every request when the text's language differs from the voice's locale; leave unset to use the voice's locale), and `SPEECHIFY_API_URL` (`https://eu.api.speechify.ai` or `https://us.api.speechify.ai` to pin a region; default `https://api.speechify.ai`).
4. Check: `/health` now lists `"speechify"` among the providers, and the tester lists the workspace's voices for the configured model under "Speechify voices", each with its preview clip.

Timed speech (`/synthesize_with_timing`, `/export`, the reader's highlighting) uses Speechify's `POST /v1/audio/speech`, which returns the audio with word-level speech marks and takes 2,000 spoken characters per request; the tester and the extension split longer text. Plain `/synthesize` uses `POST /v1/audio/stream`, which returns the bytes directly and takes 20,000. Markup tokens become real SSML here: a pause is a `<break>` and a respelling a `<sub>`, with the rest of the text escaped and wrapped in `<speak>`; hand-written SSML in the text is spoken as written. `/usage` does not report Speechify spend. Locally, put `SPEECHIFY_API_KEY=...` in `worker/.dev.vars` (ignored by git).

## Limits
- The free plan limits CPU time per request (Cloudflare's limits change, so check their docs). Waiting on Microsoft doesn't count toward it. Requests are capped at 20,000 characters, and the tester splits long text into paragraphs anyway.
- Load from URL can't reach sites that block automated access (it says so, with an "Open in browser" link), and pages built entirely in JavaScript give only their description. The browser extension reads such pages in place.
- The engine depends on an unofficial endpoint and a token scheme pinned in `engine/src/drm.js`. A scheduled GitHub Actions job ([`edge-health.yml`](../.github/workflows/edge-health.yml)) checks the voice list and a short synthesis every six hours, straight from Node and through this Worker, and opens an issue when it fails.
