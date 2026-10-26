# dan-tts plan, October 2026

**Status:** adopted with the PR that carries it; revise as workstreams land.
**In one paragraph:** dan-tts reads text aloud with natural voices and word-by-word highlighting, today entirely on Microsoft Edge's unofficial Read Aloud endpoint. This plan adds licensed voices (ElevenLabs now, Azure next) behind one server-side switch, a markup editor for pauses and pronunciation, server voices in the extension and desktop app, an offline voice, and only then a public listing. Each piece ships as its own small, tested PR, in the order below.

## 1. The ideas, in one list

| # | Workstream | What it gives a listener | Depends on |
|---|---|---|---|
| A | **Voice provider seam**: `eleven:` and later `azure:` voices next to Edge, on the Worker and the Python server, keys kept as server secrets | More and better voices, legitimately licensed; full pronunciation control on Azure | nothing |
| B | **Markup editor** (the SSML spec, `docs/specs/ssml-editor.md`): tokens like `[pause 400ms]` and `[say: Ker-nel]` in the text, lowered to what each provider understands | Pauses, respellings, emphasis, rate; the "difficult text" problems solved at the source | A (for providers that take SSML) |
| C | **Server voices in the extension and desktop app**: provider voices route through the Worker; Edge voices stay direct | The same voice everywhere you read | A |
| D | **Offline voice**: a Piper voice (from `voice-training/`) in the extension and the app, with word timings | Reading with no network and no terms | nothing |
| E | **Public listing**: Chrome Web Store, Firefox add-on signing, Calibre index | Installation without "Load unpacked" | A and D (see `edge-terms-decision.md`) |
| F | **Operations**: health check covers every provider; credit and quota visibility; one place to switch defaults | Nothing breaks silently; no surprise bills | A |

## 2. Ten lenses, ten rules

Each lens is a well-known way of thinking, applied to this project; the rule is what we do because of it.

| Lens | The idea | What it means for dan-tts | Rule we follow |
|---|---|---|---|
| **Socrates** | The unexamined claim is not worth holding; ask what you actually know | "Users want more voices" and "users want pronunciation control" are guesses | Every workstream names the question it answers and a test that could say no, before code |
| **Aristotle** | Everything has a purpose; virtue is the mean between too little and too much | dan-tts exists so a person can listen to text well; one provider is too little, five is too much | At most two licensed providers; a feature is judged by whether it makes listening better |
| **Epictetus (Stoics)** | Some things are up to us, most are not; put effort where it counts | Microsoft's endpoint, ElevenLabs' prices and quotas are not ours; our code, defaults and switches are | Every outside dependency has a switch and a fallback (the seam, the health check, the offline voice) |
| **Kant** | Act only in ways you could will everyone to act; treat people as ends, never only as means | Public distribution of header spoofing fails the test; so does hiding costs or terms from users | The terms decision stands; disclosure and attribution are not optional; keys never ship on users' machines |
| **Mill** | The right choice produces the most good for the most people | Three megabytes in a package, or ten minutes of monthly credits, are real costs to weigh against minutes of listening | Measure in listener-minutes; show quota before it runs out; prefer changes that help every user over ones that help a few |
| **William of Ockham** | Do not multiply entities beyond need | Azure's official service speaks the same protocol our engine already speaks; ElevenLabs needs a thin adapter, not a framework | One engine; a provider is a URL, headers and an adapter, never a plugin system |
| **Karl Popper** | A claim counts only if something could prove it false | "It works" is not a result; a test is | Every provider path has an offline test against a fake server and a live check in the health workflow; every PR names the test that would have failed |
| **Dewey and James (pragmatism)** | Truth is what works in practice; learn by doing | A finished visual editor nobody uses is worth less than tokens people type today | Ship the smallest slice that can be used (tester first, extension later), then improve from use |
| **Confucius** | When names are wrong, nothing that follows can be right | A voice id that hides its provider, a label that hides its cost, a README that calls an unofficial endpoint "free" | Ids carry their provider (`eleven:…`, `azure:…`); labels say who speaks and what it costs; docs say "unofficial" where it is true |
| **The Buddha** | Everything changes; do not cling; walk between extremes | Edge may stop tomorrow; the extremes are evading harder or giving up on natural voices | No evasion beyond what edge-tts does; defaults switch by configuration when things change; the health check is the alarm, not a surprise |

Two lenses change the plan outright: Ockham puts Azure on the existing engine instead of a new one, and the pragmatists put the tester ahead of the extension in every workstream. The rest keep it honest.

## 3. Workstreams

### A. Voice provider seam

**Question it answers:** do people pick a licensed voice when it sits next to the Edge ones, and does it read as well (timings, chunking, exports)?

**Design**
- Voice ids carry the provider: Edge voices keep their names (`en-US-AriaNeural`), ElevenLabs voices are `eleven:<voice_id>`, Azure voices will be `azure:<name>`.
- `/voices` returns every provider the server has a key for, each entry with `provider`, a display `name`, `gender` where known, and a `sampleUrl`.
- `/synthesize`, `/synthesize_with_timing` and `/export` route by the id's prefix. ElevenLabs uses its `with-timestamps` endpoint; its per-character times become the same word boundaries the highlighter already uses.
- `/health` lists the configured providers, so the tester can label voices and show the quota note.
- Keys: `ELEVENLABS_API_KEY` as a Cloudflare secret (Settings → Variables and secrets → Secret) and as an environment variable on the Python server; `ELEVENLABS_MODEL` optional. Never in client code.
- Errors say what happened in plain words: a rejected key, credits used up for the month, a text too long for the provider.
- Azure follows with the same engine: the official WebSocket endpoint, a key, and full SSML allowed.

**Done when:** the tester lists ElevenLabs voices beside Edge voices, reads with highlighting, exports captions; offline tests cover the adapter and routing on both servers; the health check lists voices from every configured provider; READMEs say where the key goes and what the free plan allows.

**Status (2026-10-26):** the ElevenLabs half is built: `worker/src/elevenlabs.js` and the `_eleven_*` helpers in `app/main.py`, routing by the `eleven:` prefix, `/health.providers`, previews as samples (no credits), the tester's provider labels and quota note, provider voices in the health check, and offline tests on both servers. Azure is next and needs a key.

### B. Markup editor

**Question:** do pauses and respellings fix the texts people actually struggle with (names, abbreviations, dialogue)?

**Design:** the spec's tokens (`[pause 400ms]`, `[say: Ker-nel]`, `[spell: SSML]`, `[slow]…[/slow]`) in one shared module with tests; each provider gets what it understands: Azure full SSML; ElevenLabs `<break time>` and respelled text; Edge respelled text, punctuation-based pauses and prosody. Captions carry the spoken words, never the markup.

**Done when:** `lower()` and the per-provider lowering have unit tests; the tester has the Markup toggle and preview; highlighting survives a pause.

**Status (2026-10-26):** phase 1 built. `static/markup.js` parses `[pause]`, `[pause 800ms]`, `word[say: respelling]` and `[spell: ABC]`, leaves other brackets alone, and lowers per provider: Edge gets punctuation for pauses (comma, full stop, paragraph break) and plain respellings; ElevenLabs gets `<break time>` tags (3 s cap) and the same respellings; `strip()` gives the written text. The tester's "Markup tokens" switch lowers the text for the chosen voice before synthesis (Synthesize and Batch), and synthesizes each paragraph of lowered text as its own request so a long Edge pause is a real gap. Listening checks with real voices, the text preview and toolbar (phase 2) and the extension (phase 3) remain.

### C. Server voices in the extension and desktop app

**Question:** will people accept a server hop (and a quota) for a better voice while reading pages?

**Design:** a "server" setting (default: the Worker); provider voices appear in the reader's voice picker under their provider and route through `/synthesize_with_timing`; Edge voices stay direct. The desktop app shares the code.

**Done when:** an end-to-end check reads a page with an `eleven:` voice when a key is configured, and skips cleanly when it isn't.

**Status (2026-10-26):** built. `engine/src/server.js` (shared with the extension and the desktop app) lists provider voices from `/voices` and speaks through `/synthesize_with_timing`; the reader groups them under their provider, the player routes by the id prefix and prefetches a paid chunk only once the current one is mostly played; the extension has an options page for the server (empty = Edge only) and the desktop app a matching Settings page on its home screen; the desktop app calls the server through its main process. The Chromium end-to-end test reads a page with an `eleven:` voice from a stand-in server, so no key is needed in CI.

### D. Offline voice

**Question:** is an on-device voice good enough that people keep it on?

**Design:** Piper (ONNX) in the extension via WebAssembly, or in the desktop app natively; word timings from phoneme alignment; the voice from `voice-training/` or a stock Piper voice.

**Done when:** a page reads with highlighting with the network off.

**Status (2026-10-26):** researched; decided; spike under way. [`docs/spikes/offline-voice.md`](spikes/offline-voice.md) compares the engines and recommends Piper through onnxruntime-web with its alignment patch for the first slice (fits Firefox's 200 MB limit, real time on one thread, native word timings), with Kokoro-82M as the better-sounding second slice where WebGPU or the desktop app's native runtime is available. **Decisions (owner, 2026-10-26):** the project is licensed GPL-3.0-or-later (`LICENSE`); the first offline voice is Piper with the public-domain `en_US-ljspeech-medium` voice; Azure AI Speech is wanted as the next provider (key to come).

### E. Public listing

Only after A and D, per the terms decision: public builds default to a licensed or offline voice; Edge stays the self-hosted default. Firefox signing, Chrome Web Store, Calibre index, in that order.

### F. Operations

The health check lists voices from every configured provider (listing costs no credits); a `/usage` view shows remaining credits where the provider exposes them; defaults live in one place on each server.

**Status (2026-10-26):** `/usage` exists on both servers (Edge: no quota; ElevenLabs: used, limit, remaining and reset date, cached a minute, a failed lookup reported rather than raised); the tester shows the live count under the voice picker and the health check logs it when a key is configured.

## 4. Order and size

1. **A, ElevenLabs** (now; a few days of work, one PR). 2. **F** alongside A. 3. **A, Azure** (same engine, needs a key). 4. **B** (one PR for the module and tester, one for the extension). 5. **C**. 6. **D** (largest; a spike first). 7. **E**.

## 5. Risks, and the switch for each

| Risk | Switch |
|---|---|
| Edge endpoint changes | health check alarms; default provider switches by configuration; offline voice |
| ElevenLabs free credits run out mid-month | quota shown in the tester; clear error; Edge voices still work |
| A key leaks | keys only on servers; rotate in the dashboard; the Worker never echoes them |
| Markup breaks highlighting | boundaries map to spoken words only; tests for pauses |
| Offline voice sounds worse | it is a choice, not the default, until listeners keep it on |

## 6. Decided here, so we don't re-decide

- Provider ids are prefixed; Edge ids are unchanged.
- Keys live on servers only.
- The tester is the first surface for every workstream; the extension and app follow.
- Azure is implemented on the existing engine protocol, not a second engine.
- No store listing before A and D.
