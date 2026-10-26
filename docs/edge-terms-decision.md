# Edge voice service: terms, and what we ship publicly

**Status:** proposed 2026-10-26; adopted when the pull request carrying this file is merged.
**Decides:** the roadmap item "Decide Edge terms for public release", which gates the Calibre plugin and any store listing.
**Not legal advice:** this is the owner's reading of public documents, written down so the project acts consistently.

## What dan-tts does today

Every part of dan-tts gets its voices from `speech.platform.bing.com`, the endpoint Microsoft Edge's built-in **Read Aloud** uses. It is not a published API and has no terms of its own. The endpoint only answers requests that look like Edge, so the engine sends what Edge sends: a fixed "trusted client token", a time-based `Sec-MS-GEC` token (`engine/src/drm.js`, ported from the edge-tts Python library), and Edge's `User-Agent` and `Origin` headers.

| Where | How the headers are set | Distributed how |
|---|---|---|
| Python server (`app/main.py`) | the `edge-tts` library | this repo; Render |
| Cloudflare Worker (`worker/`) | on its outbound WebSocket | dan-tts.macdaddydwj.workers.dev |
| Browser extension (`extension/`) | a `declarativeNetRequest` rule, for the extension's own requests only | "Load unpacked"; Firefox temporary or self-signed build; **no store** |
| Desktop app (`desktop/`) | rewritten in the Electron main process | GitHub Releases, unsigned |
| Calibre plugin (PR #31) | none: it talks to a dan-tts server | not released |

## The facts that matter

1. **The same voices are a paid product.** Azure AI Speech sells these neural voices with a free tier of 0.5 million characters a month and a per-character price above that (Microsoft's US page showed no number when checked; the last widely quoted rate is about $15 per million characters). A novel is roughly half a million to a million characters. Read Aloud is the same service without a bill.
2. **Microsoft's terms forbid getting around access restrictions.** The Microsoft Services Agreement's code of conduct says not to circumvent restrictions on access to, usage of, or availability of its services. Presenting Edge's identity to an endpoint that only answers Edge is that, on a plain reading.
3. **Microsoft tolerates it, and also pushes back.** edge-tts has worked in the open for years without legal action against it or its users. Microsoft has, though, hardened the token scheme (that is why `drm.js` exists) and blocked SSML that Edge itself wouldn't send, which is why edge-tts dropped custom SSML. Expect more of the same, and expect no notice.
4. **It can stop at any time, for everyone at once.** A token or endpoint change breaks every installed copy in the same minute. The six-hourly health check (`.github/workflows/edge-health.yml`) tells us; it doesn't fix anything.
5. **Personal use and public distribution carry different exposure.** Used by one person, the risk is that a free service stops. Listed on a store or index, every installer is doing this under dan-tts's name, and a reviewer (Chrome Web Store, addons.mozilla.org, Calibre's plugin index) can reasonably ask how the voices are licensed. There is no good answer today.
6. **The alternatives, as they stand:**
   - **Azure AI Speech (official):** the same voices, word timings, full SSML (pronunciation and pauses, which the Edge path can't do). Needs an API key, so it belongs on a server (the Worker or the Python server), never in the extension or the app. Free for 0.5 million characters a month per account, paid beyond.
   - **ElevenLabs:** better voices, different ones. The free plan (which the owner has) is 10,000 credits a month, about ten minutes of speech, non-commercial with attribution; the first paid plan is about $5 a month. Also key-based, so server-side only.
   - **An offline voice:** Piper, which `voice-training/` already targets with a consented, self-recorded dataset, or the browser's own `speechSynthesis`. No terms, no network, no bill; noticeably less natural, and word highlighting needs the engine to report timings (Piper can; browser voices vary).

## Decision

**Edge stays the engine for personal and self-hosted use. Nothing that is listed on a public store or index ships the Edge path.**

In practice:

1. **Keep using Edge** in the website and tester, the unpacked and self-signed extension, the desktop app on GitHub Releases, the local Python server and the Worker. These are distributed from this repository, to people who read its README.
2. **Say what it is, everywhere it ships.** Each README carries the same note: *dan-tts uses Microsoft Edge's Read Aloud service unofficially, the way the edge-tts library does. It is for personal use, is not affiliated with Microsoft, and can stop working at any time.* No marketing copy describes the voices as free or licensed.
3. **No store or index listing with the Edge engine.** Not the Chrome Web Store, not a public addons.mozilla.org listing, not Calibre's plugin index. The Calibre plugin can merge and be installed from a file; it says it needs a dan-tts server and inherits that server's engine.
4. **A public listing needs a licensed or offline voice first.** Before any listing, add a provider seam to the servers (`provider: edge | azure`, the Azure key kept as a secret on the Worker or server) and, for the extension and app, an offline voice. The Edge path stays as the self-hosted default.
5. **If Microsoft changes or blocks the endpoint:** update from edge-tts if a fix exists, otherwise switch defaults to the official provider or the offline voice. Do not escalate evasion: no proxy rotation, no spoofing beyond what edge-tts itself does.

## Why this line

The voices and word timings are the point of dan-tts, and the free Edge path is the only way to have them at no cost. For one person's reading, the realistic downside is the service stopping, which the project already plans for. A public listing changes who carries the exposure and invites a licensing question with no good answer, while the cost of a legitimate path at personal volumes is zero to small. So the line is drawn at public distribution, not at use.

## Consequences

- **Calibre plugin (PR #31):** unblocked as an install-from-file plugin; no index submission.
- **Extension:** stays "Load unpacked" and self-signed Firefox builds; no store listing.
- **Desktop app:** releases continue, with the terms note in its README.
- **Roadmap:** two new medium-term items: a server-side provider seam with Azure AI Speech, and an offline voice. Store listings depend on them.
- **Review this decision** if Microsoft publishes terms for the endpoint, blocks it, or if dan-tts gains users beyond the owner's circle.
