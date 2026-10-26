# dan-tts engine (feasibility spike)

A dependency-free JavaScript client for Microsoft Edge's read-aloud voices: **text in, MP3 + word timings out, no server.** The goal is one engine that a browser extension, an Electron reader and a Cloudflare Worker can all share, so nothing depends on the Render-hosted Python server.

```js
import { synthesize, connectionHeaders } from './src/tts.js';

// Node / Electron: set the headers the service expects on the socket itself
const openSocket = (url) => new WebSocket(url, { headers: connectionHeaders() });

const { audio, boundaries } = await synthesize('Hello world', { voice: 'en-US-AriaNeural', openSocket });
// audio: Uint8Array (MP3, 24 kHz, 48 kbps CBR); boundaries: [{ offset, duration, text }] in 100 ns ticks
```

`openSocket` is the only platform-specific part. It may return an open or a connecting socket, or a promise of one.

## Feasibility results (2026-10-19)

| Test | Result |
|---|---|
| **Token** (`Sec-MS-GEC` v2) | ✅ Ported from edge-tts 7.3.1. Matches the Python reference on 5 of 5 test vectors (`test/drm.test.js`) |
| **Node, direct** (Electron path) | ✅ Real MP3 and 12 word boundaries in about 0.6 to 1.1 s, with no server |
| **Browser extension** (Chromium, MV3) | ✅ Works using a `declarativeNetRequest` rule that sets `Origin` and `User-Agent`. **Control:** with the rule disabled, the connection is refused. Real audio and 11 words in 0.8 s. No cookie needed |
| **Cloudflare Worker** (local `wrangler dev`, real workerd runtime) | ✅ 3.5 s clip in 0.45 s. 87 s paragraph (220 words) in 4.6 s |
| **Readability** (article extraction, no AI) | ✅ Wikipedia: 700 KB of HTML became a 70 KB clean article. The full *Pride and Prejudice* came through from Gutenberg |

### Verified since
- **Cloudflare production** (2026-10-25): Microsoft accepts connections from Cloudflare's servers, and short and paragraph-length requests run within the free plan's limits. The deployed Worker is the tester's default API. `scripts/edge-health.mjs` re-checks the direct and Worker paths every six hours from CI.
- **Firefox** (Firefox 158): the `Origin` rewrite works on WebSockets too; the extension supports Firefox 140+.

### Gotchas found
- **The token was hardened.** v2 tokens combine a SHA-256 with a hidden prefix and a custom checksum. `src/drm.js` is a straight port. **If Microsoft changes the scheme again, update it from upstream edge-tts and refresh the test vectors.** This is the main maintenance risk.
- **Cloudflare delivers binary frames as `Blob`** unless `binaryType = 'arraybuffer'` is set before `accept()`. See `examples/cloudflare-worker`.
- **Audio is constant-bitrate (48 kbps), so `duration = bytes × 8 / 48000` exactly** (`mp3BytesToTicks`). Chunked playback can line up timings without decoding audio.

## Layout
- `src/drm.js`: token generation
- `src/tts.js`: WebSocket protocol, SSML, frame parsing
- `test/`: offline tests (token vectors, plus protocol with a fake socket). Run with `npm test`.
- `examples/extension/`: minimal MV3 extension used for the spike. Copy `src/*.js` into `examples/extension/engine/`, then load it unpacked.
- `examples/cloudflare-worker/`: minimal Worker relay. Run with `npx wrangler dev` from that folder.

## Terms
This talks to the same endpoint Edge's built-in Read Aloud uses, in the same way the edge-tts Python library does. dan-tts uses Microsoft Edge's Read Aloud service unofficially, the way the edge-tts library does. It is for personal use, is not affiliated with Microsoft, and can stop working at any time. See [`docs/edge-terms-decision.md`](../docs/edge-terms-decision.md) for what is and isn't distributed publicly.
