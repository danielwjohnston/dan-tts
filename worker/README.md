# dan-tts API on Cloudflare Workers (free)

The same API as the Python server, running on Cloudflare's free plan. Unlike Render's free plan it **never sleeps** (no one-minute wake-up), and it allows about 100,000 requests a day.

| Endpoint | On the Worker |
|---|---|
| `GET /health`, `GET /voices`, `GET /samples/{voice}` | ✅ (voices and samples are cached) |
| `POST /synthesize`, `POST /synthesize_with_timing` | ✅ MP3 only |
| `POST /export?format=json\|webvtt\|srt` | ✅ |
| `POST /extract_text` (Load from URL) | ❌ Returns a clear message. Use the Render API for this, or the browser extension, which reads pages directly. |

The [tester](https://danielwjohnston.github.io/dan-tts/tester.html) works with it unchanged: put the Worker's address in **Advanced → API Base URL**. This was tested end to end against a local Worker: synthesis, standalone HTML export and batch zips.

## One-time setup (about 10 minutes, all in your browser)

After this, every push to `main` that touches the Worker or the engine redeploys it automatically.

1. **Create a free Cloudflare account** at https://dash.cloudflare.com/sign-up. No card is needed for Workers.
2. **Find your Account ID.** In the Cloudflare dashboard, open **Workers & Pages**. The **Account ID** is in the right-hand column. Copy it.
3. **Create an API token.** Click your profile icon → **My Profile** → **API Tokens** → **Create Token**. Use the **Edit Cloudflare Workers** template, set *Account Resources* to your account and *Zone Resources* to *All zones*, then **Continue to summary** → **Create Token**. Copy the token; it's shown only once.
4. **Give both to GitHub.** In this repo on GitHub: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Add two secrets:
   - `CLOUDFLARE_API_TOKEN`: the token from step 3
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 2
5. **Deploy.** Go to **Actions** → **Deploy Cloudflare Worker** → **Run workflow**. When it turns green, the log shows your address, something like `https://dan-tts.<your-subdomain>.workers.dev`.
6. **Check it:** open `https://dan-tts.<your-subdomain>.workers.dev/health`. You should see `{"status":"ok","runtime":"cloudflare-worker"}`.
7. **Use it:** in the tester, open **Advanced** and set **API Base URL** to that address. To make it the default for everyone, tell Claude the address and it will update `tester.html`.

Never paste the token anywhere except GitHub's secret box. If it leaks, delete it under **API Tokens** and make a new one.

## Local development

```bash
cd worker
npm install
npx wrangler dev        # http://127.0.0.1:8787
```

The Worker imports the shared engine from `../engine/src`, so there's nothing to copy or sync.

## Known unknowns
- Microsoft's voice service could treat requests from Cloudflare's servers differently from home connections. Local testing can't show this, so the first real deploy is the test. If `/synthesize` returns a 502 from the deployed Worker, Render still works and nothing else is affected.
- The free plan limits CPU time per request (Cloudflare's limits change, so check their docs). Waiting on Microsoft doesn't count toward it. Requests are capped at 20,000 characters, and the tester splits long text into paragraphs anyway.
