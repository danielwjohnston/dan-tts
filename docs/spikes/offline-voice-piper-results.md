# Spike results: Piper offline voice, Node level (Workstream D)

Date: 2026-10-26. Steps 1 to 3 of the plan in [`offline-voice.md`](offline-voice.md) §6, run at the Node
level in a scratch directory outside the repository. Nothing here is wired into the extension yet; step 4
(the Worker in the offscreen document, Firefox, Electron, listening tests) is next. Decisions taken by the
owner before this spike: licence GPL-3.0, engine Piper, voice `en_US-ljspeech-medium` (public domain).

## Short answer

**It works, with two corrections to the plan.** `en_US-ljspeech-medium` patched with Piper's alignment tool
runs under onnxruntime-web 1.30.0's WebAssembly backend on one thread, returns per-phoneme frame counts
that sum exactly to the audio length, and synthesizes at **0.29 to 0.35× real time** on this machine (a
2.1 GHz Xeon vCPU), with a **2.2 s model load** and about **97 MB** of files to bundle.

1. **eSpeak-ng does not keep a space between every pair of words.** It joins unstressed function words to
   their neighbours (`in the` → `ɪnðə`, `in silence`, `well-known`, `e.g.` → "for example" as one token):
   a 303-word paragraph came back as 289 spoken words. Counting spaces, as the plan assumed, mis-times about
   one word in twenty and the proportional fallback would then drift by seconds. The fix, implemented and
   measured here, is a phoneme-level alignment: phonemize every word on its own in the same phonemizer call
   (304 texts in one call, 100 to 140 ms) and align the connected phoneme stream to the per-word phonemes
   with a Needleman–Wunsch pass (1 to 4 ms per sentence, 80 to 110 ms for the paragraph). Every word of
   every test then gets its own span, including expansions (`$3.50` → five spoken words) and merges.
2. **Memory grows with the longest single model input and never shrinks**: about 23 MB of resident memory per
   second of audio in one run, on top of about 300 MB after loading. A 47 s sentence took the process to
   1.5 GB. The engine must cap one model run at roughly 12 s of audio (about 400 phoneme ids) by splitting
   long sentences at clause punctuation.

Also: sentence-sized chunks are required for the "first audio under 2 s" criterion (a 1,200-character chunk
takes 20 to 30 s to synthesize at this speed), and the ONNX checker rejects the patched model's untyped
second output while both onnxruntime 1.31 (Python) and onnxruntime-web 1.30 accept it unchanged.

## Machine

4 vCPU Intel Xeon @ 2.10 GHz (family 6, model 207, AVX-512 present but irrelevant to 128-bit WebAssembly
SIMD), KVM, 15 GB RAM, Linux 6.18, Node 22.22.0, Python 3.13.17. All WebAssembly runs were single-threaded
(`ort.env.wasm.numThreads = 1`, Node has no multi-threaded ORT-web anyway). A 2020 laptop core at a higher
clock should be in the same range per thread; low-end and ARM laptops remain unmeasured.

## Step 1: voice and alignment patch (Python)

```sh
python3 -m venv venv && ./venv/bin/pip install 'piper-tts[alignment]' onnx     # 8 s; network fine
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json
./venv/bin/python -m piper.patch_voice_with_alignment en_US-ljspeech-medium.onnx --output en_US-ljspeech-medium-aligned.onnx
# INFO: Marked tensor as output: /Ceil_output_0   (1.6 s)
```

| | |
|---|---|
| Packages | piper-tts 1.8.0, onnxruntime 1.31.0, onnx 1.23.2, numpy 2.5.4 |
| Model | 63,531,379 bytes, SHA-256 `6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22`; opset 15, ir 8, PyTorch 2.1.2 export, 6,423 nodes, 51 op types |
| Patched model | 63,531,397 bytes (+18: one output name), SHA-256 `60357a3435a56c5b08b34113ae77a3635b3322950bd845db61ad016b3159f546` |
| Config | `sample_rate` 22050, `espeak.voice` **`en`** (not `en-us`), `num_symbols` 256, `phoneme_id_map` 157 entries (`_`→0, `^`→1, `$`→2, space→3), `inference` noise 0.667, length 1, noise_w 0.333; no `hop_length` key (Piper's default 256 applies) |
| Inputs | `input` int64 [batch, phonemes]; `input_lengths` int64 [batch]; `scales` float32 [3] |
| Outputs | `output` float32 [batch, 1, 1, time]; `/Ceil_output_0` **untyped in the file** (onnx.checker: "Field 'type' of 'value_info' is required but missing"); onnxruntime reports it as float32 [batch, 1, phonemes] |
| Python check | "Dr. Smith paid $3.50 on 12 May 2024." → 2 sentences (eSpeak ends a sentence at "Dr."), 17 + 183 ids, 9 + 92 alignments; alignment samples sum to 12,544 and 107,008 = the audio lengths exactly; native RTF 0.05 (4 threads), load 1.8 s, 249 MB RSS |

The voice's eSpeak voice is `en` (British English phonemes: `dˈɒktə`, `zˈiəɹəʊ`); `en_US-kristin` uses `en`
too, `en_US-lessac` uses `en-us`. The model was trained on `en`, so the engine must read the value from the
`.onnx.json` rather than assume `en-us`.

## Step 2: the Node pipeline

```sh
npm init -y && npm install onnxruntime-web@1.30.0 @diffusionstudio/piper-wasm     # 4 s, 166 MB node_modules
node spike.mjs en_US-ljspeech-medium-aligned.onnx en_US-ljspeech-medium-aligned.onnx.json out/
```

Pipeline, all in JavaScript with the two libraries injected (the same code is meant to run in the Worker):

1. **Phonemize** with piper-wasm: `createPiperPhonemize({ print, printErr, locateFile })`, then
   `callMain(['-l', config.espeak.voice, '--input', JSON.stringify(texts.map(text => ({ text }))), '--espeak_data', '/espeak-ng-data'])`.
   One instance serves the whole session (`callMain` can be called repeatedly; 11 to 38 ms per sentence,
   100 to 140 ms for 304 texts). `--input` takes an array, so the whole text and every whitespace-split
   word are phonemized in one call. Output per text: `phoneme_ids` (sentences joined as `… 2, 1 …`,
   that is EOS then BOS) and a flat `phonemes` list with no sentence marks; sentences are recovered from
   the ids. The package's `main` field is `/build/piper_phonemize.js` with a leading slash, so it is loaded
   by path, which an extension does anyway.
2. **Ids** from the voice's `phoneme_id_map`: `[1, 0, id, 0, id, 0, …, 2]`. In every test the ids built in
   JavaScript equalled the tool's own `phoneme_ids`, so the map in the `.onnx.json` is authoritative and
   complete (no missing phonemes for accents, emoji, Greek, CJK, control characters, smart quotes).
3. **Model** per sentence: `InferenceSession.create(bytes, { executionProviders: ['wasm'] })` with
   `env.wasm.numThreads = 1`, `env.wasm.proxy = false`, `env.wasm.wasmPaths` pointing at the directory
   with `ort-wasm-simd-threaded.wasm`. Feeds as above; `session.outputNames` = `['output', '/Ceil_output_0']`.
4. **Alignment**: frames × 256 = samples per input id. Following Piper, a phoneme owns its id plus the PAD
   after it, BOS owns BOS + PAD, EOS owns itself. The frame sum × 256 equalled the audio length in every run.
5. **Words**: the stream is aligned to the per-word phonemes (global alignment; match +3, stress or length
   mark match +1, mismatch −2, gap −1; unmatched stream phonemes inherit the previous word). Each word's span
   is the first to last sample of its phonemes; words that produce no phonemes ("—") get a zero-length
   boundary where they sit. Offsets and durations convert to 100 ns ticks for the player's
   `{ offset, duration, text }` contract.
6. **WAV**: 16-bit PCM mono 22,050 Hz (validated with `file` and Python's `wave`), `contentType: 'audio/wav'`.

### Numbers

| Measure | Result |
|---|---|
| piper-wasm ready | 44 to 48 ms (Node reads the 18 MB `.data` from disk; in the extension it is a package fetch) |
| ORT session create (WASM compile + 63.5 MB model) | 2,139 to 2,444 ms over four runs |
| First `run` (warm-up) | 0.8 s of audio in 373 to 383 ms, RTF 0.45 to 0.54 |
| Sentences (4.6 to 9.3 s of audio) | RTF 0.27 to 0.36, model time 99% of the total |
| 300-word paragraph (303 words, 1,592 chars, 12 sentences) | 92.6 to 93.5 s of audio in 26.4 to 29.0 s: **RTF 0.28 to 0.31** (three runs) |
| Phonemizer, paragraph + 303 words in one call | 102 to 141 ms |
| Word alignment, paragraph | 78 to 107 ms (1 to 4 ms per sentence) |
| Boundaries | monotonic in every run; count = whitespace words in every run; first word starts at 23 to 46 ms (BOS silence), last ends 23 to 46 ms before the audio end (EOS); median word 0.22 to 0.34 s, none over 2.5 s |
| Node RSS | 45 MB at start, 75 MB with the phonemizer, **404 to 439 MB after the session** (of which 64 MB is Node's copy of the model bytes) |
| RSS growth per model run (never released) | 3.2 s audio → 614 MB; 6.1 s → 666; 12.0 s → 784; 17.8 s → 866; 23.7 s → 1,017; 35.3 s → 1,264; **47.2 s → 1,482 MB**, about 23 MB per second of audio in one input |
| `enableCpuMemArena: false, enableMemPattern: false` | no change (791 vs 792 MB peak for the same run); it is the WebAssembly heap, not the arena |
| Native Python onnxruntime, same model, 4 threads | RTF 0.05 to 0.09, 249 MB RSS (the desktop app's `onnxruntime-node` path would look like this) |

### Word mapping on numbers and abbreviations

"Dr. Smith paid $3.50 on 12 May 2024." → 16 spoken words for 8 text words. eSpeak expands `Dr.` to
"doctor" and ends a sentence there, `$3.50` to "dollar three point five zero", `12` to "twelve", `2024` to
"two thousand and twenty four". The alignment gives (offset + duration, seconds):

```
0.023 +0.511 Dr.      0.720 +0.221 Smith    1.010 +0.255 paid   1.312 +1.602 $3.50
2.937 +0.116 on       3.100 +0.290 12       3.425 +0.151 May    3.669 +1.579 2024.
```

Other behaviour seen: `well-known` → one spoken token `wˈɛlnˈəʊn`; `U.S.` → `jˌuːˈɛs` (one token); `e.g.`
→ "for example" in context but `ˌiːdʒˈiː` alone (the alignment still placed it); `1990s` → three words
"nineteen hundred and ninety s"; `100%` → "one hundred percent"; `&` → "and"; `—` → a `;` pause, silent;
`St.` → "saint" in "Downing St."; `3pm` → "three p m"; `€20` → "euros twenty"; `👍` is spoken as "thumbs
up"; `东京` as "Chinese letter Chinese letter". Paragraph breaks (`\n\n`) end a sentence but drop the `.`
phoneme; harmless. The sentence-end split differs from `chunk-text.js` ("Dr." ends a sentence for eSpeak,
not for the chunker), which does not matter once words are aligned by phonemes rather than by sentence.

### onnxruntime-web and the patched model

Accepted as is: the second output arrives as float32 `[1, 1, N]`, N = number of input ids. No fix needed.
If a future ORT version insists on a typed output, the patch script's `ValueInfoProto` can be given
`type.tensor_type.elem_type = FLOAT` and shape `[batch, 1, phonemes]` (one line in
`piper/patch_voice_with_alignment.py`, or a post-processing step with `onnx.helper.make_tensor_value_info`).

`ort-wasm-simd-threaded.wasm` is the only CPU binary in 1.30.0 (the `ort-wasm-simd.wasm` non-threaded
build last shipped in 1.18). It **imports a shared memory** (limits flags 3, 16 MB initial, 4 GB max) and
the glue always calls `new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true })`; ORT sets
`numThreads = 1` when `self.crossOriginIsolated` is false. This is designed to run single-threaded in
non-isolated pages, which is what a Firefox extension page is, but it was not verified here (Node always
has `SharedArrayBuffer`). The contingency if Firefox refuses shared memory in extension pages is pinning
onnxruntime-web 1.18.0 for its non-threaded binary. The piper-wasm binary defines its own non-shared
memory, fixed at 16 MB (no growth); the eSpeak data lives in the Emscripten virtual file system in JS memory.

## Step 3: files to bundle under `extension/lib/piper/`

| File | Bytes | From | Licence |
|---|---|---|---|
| `ort.wasm.bundle.min.mjs` (or `ort.wasm.min.mjs` 50,196 + `ort-wasm-simd-threaded.mjs` 24,381) | 73,054 | onnxruntime-web 1.30.0 `dist/` | MIT (the npm package ships no LICENSE file; take the text from the GitHub release) |
| `ort-wasm-simd-threaded.wasm` | 14,239,897 | onnxruntime-web 1.30.0 `dist/`, SHA-256 `3398c10d07d229bd…` | MIT |
| `piper_phonemize.js` | 120,714 | @diffusionstudio/piper-wasm 1.0.0 `build/` | MIT label; contains eSpeak-ng: **GPL-3.0-or-later** |
| `piper_phonemize.wasm` | 635,212 | same, SHA-256 `b777cd107a91d2bc…` | GPL-3.0-or-later (eSpeak-ng) + MIT (piper-phonemize) |
| `piper_phonemize.data` | 18,077,249 | same, SHA-256 `29f1025eb23a5b5c…`; 494 files, eSpeak data for every language | GPL-3.0-or-later |
| `voices/en_US-ljspeech-medium.onnx` (patched) | 63,531,397 | rhasspy/piper-voices, patched as above | model trained on the public-domain LJ Speech dataset; see the voice's MODEL_CARD |
| `voices/en_US-ljspeech-medium.onnx.json` | 4,972 | rhasspy/piper-voices | same |
| `LICENSE-*.md`, `VERSION.txt` | small | as for `lib/tesseract/VERSION.txt`: versions, both SHA-256s of the voice, the patch command | |
| **Total** | **≈ 96.7 MB** | | |

An English-only eSpeak data package would be about 0.9 MB (`phondata` 594,464, `phontab` 63,700,
`phonindex` 48,584, `intonations` 2,584, `en_dict` 168,294, plus `lang/gmw/en*` and `voices/`), saving 17 MB,
but it means repackaging the Emscripten `.data` file, which makes piper-wasm a modified library for Firefox
review. The ORT variants `jsep` (28 MB, WebGPU), `jspi` (17 MB) and `asyncify` (27 MB) are not needed.

## Proposed design

**`extension/engine/piper.js`** (pure, no DOM, no `chrome.*`, testable with `node --test` like `align.js`):

- `isPiperVoice(voice)`: `/^piper:/`. Must be checked **before** `isServerVoice` in the player, because
  `isServerVoice` matches any `prefix:` id and would send `piper:ljspeech` to the voice server.
- `VOICES = { 'piper:ljspeech': { model: 'lib/piper/voices/en_US-ljspeech-medium.onnx', config: '…onnx.json', label: 'LJ Speech (offline)' } }`.
- The functions proven in the spike: `phonemesToIds(phonemes, idMap)`, `splitSentences(toolIds, phonemes, idMap)`,
  `alignPhonemes(phonemes, ids, frames, hopLength, idMap)`, `alignStreamToTokens(stream, tokenPhonemes)`,
  `encodeWav(samples, sampleRate)`, and `synthesizeCore(text, { phonemize, session, config, ort })` →
  `{ audio: Uint8Array, boundaries, contentType: 'audio/wav' }`. The spike's version of these is in the
  session scratch directory (`piper-core.mjs`, about 300 lines) and should be moved into the repo with tests
  built on recorded phoneme and frame fixtures, so the tests need neither the model nor the WebAssembly.
- A length cap: a sentence whose ids exceed about 400 (≈ 12 s of audio) is split at `, ; :` phonemes before
  the model runs, and the pieces are concatenated; this bounds the WebAssembly heap at roughly 800 MB
  process RSS as measured here (about 500 MB of it the heap).
- Tokens are the text's whitespace-split words, as the player and `lib/align.js` expect; `align.js` then maps
  them to the page as it does for Edge boundaries.

**`extension/engine/piper-worker.js`**: holds the phonemizer instance and the ORT session for the lifetime
of the Worker; `postMessage({ text, voice })` → `{ audio, boundaries, contentType }` with the audio buffer
transferred. Loads `ort.wasm.bundle.min.mjs` with `ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/piper/')`,
`numThreads` 1 (Firefox, or any non-isolated page) or `navigator.hardwareConcurrency` only if
`crossOriginIsolated` is true in the offscreen document (unverified); piper-wasm via `importScripts` or a
dynamic import with `locateFile: (f) => chrome.runtime.getURL('lib/piper/' + f)`. The first request pays the
2.2 s load; later requests are synthesis only.

**Player** (`offscreen.js`, used unchanged by the Firefox background page and the Electron window):
route `isPiperVoice(voice) ? synthesizePiper(chunk, { voice }) : isServerVoice(voice) ? synthesizeServer(…) : synthesize(…)`;
prefetch the next chunk as for Edge voices (offline synthesis costs no credits). **Chunk size**: for
`piper:` voices call `chunkText(text, { target: 250, max: 400 })`, that is one or two sentences, so the
first audio arrives after about 1.5 to 3 s of synthesis at this speed and the prefetch keeps ahead
(RTF 0.3 leaves a 3× margin). The 1,200-character default would mean a 20 to 30 s wait per chunk.

**Manifest**: add `"WORKERS"` to the offscreen reasons; the CSP already has `'wasm-unsafe-eval'`; no new
host permissions (everything is in the package). Firefox: the same files; the background page creates the
Worker. **Desktop app**: the same `engine/piper.js` with `onnxruntime-node` injected as `session`
(RTF 0.05 to 0.09 measured natively) and the same piper-wasm phonemizer, or the Python server's Piper.

**Voice selection**: `piper:ljspeech` listed in the reader's picker under "Offline", with the note that it
sounds plainer than the network voices and reads with British-influenced phonemes (`en`).

## GPL and licence notes

- Shipping eSpeak-ng (GPL-3.0-or-later) in the extension makes the extension build a GPL-3.0 combined work,
  as the owner has decided. The repository still has **no top-level LICENSE file**: add GPL-3.0 before the
  files land, and a `NOTICE` naming eSpeak-ng, piper-phonemize (MIT), onnxruntime (MIT), Piper (GPL-3.0,
  as the training and patching tool: none of its code ships in the extension) and the voice's dataset.
- The GPL requires offering the corresponding source of the eSpeak-ng build. The npm package carries only
  the build output and a README with the June 2024 build steps (emsdk 3.1.47, rhasspy/espeak-ng and
  wide-video/piper-phonemize at unpinned `--depth 1` clones). For a clean offer, and for Firefox's rule that
  third-party libraries be reproducible, the project should either pin and script that build itself
  (a Dockerfile under `voice-training/` or `scripts/`) or ask the reviewers to accept the npm artefact plus its
  recipe. This is the main listing risk from this spike.
- The patched voice differs from the published file by 18 bytes; `VERSION.txt` records both SHA-256s and the
  command so anyone can reproduce it. It is data, not a library, for store review purposes.
- The LJ Speech dataset is public domain and the voice's MODEL_CARD says so; carry Piper's "personal use and
  research" wording into the disclosure as `offline-voice.md` recommends.
- `@diffusionstudio/piper-wasm` and `phonemizer` are labelled MIT on npm but contain eSpeak-ng: treat as GPL.

## Open risks and what step 4 must verify

1. **Shared WebAssembly memory in a Firefox extension page** (not cross-origin isolated): ORT 1.30's only
   binary requires it. If it fails, pin onnxruntime-web 1.18.0. Verify first; it decides the ORT version.
2. **Speed on real laptops**: 0.29 to 0.35 here on one server core; the exit criterion is 0.7 on a 2020-class
   laptop. Measure in Chrome (and with threads if the offscreen document can be isolated) and in Firefox.
3. **Memory**: 400 MB after load and up to 800 MB with the 12 s cap, per Worker. Decide whether to tear the
   Worker down after a pause (reload costs 2.2 s) and check the browsers' per-renderer limits are not hit on
   32-bit or low-memory machines.
4. **Firefox linter** with 63.5 MB and 14 MB files (`web-ext lint`), and the reproducible-build requirement.
5. **Highlight drift by ear**: the timings are exact to the model's 11.6 ms frame, but the model's own
   placement of pauses (the `,` and `.` phonemes own 0.1 to 0.2 s each, assigned to the preceding word) and
   merged function words need a listening check against the 100 ms target.
6. **Pronunciation**: British phoneme set on an American voice (that is how it was trained); numbers read in
   British style ("two thousand and twenty four"); `U.S.` → "u s"; emoji and CJK spoken literally. A
   pre-phonemizer clean-up (strip emoji, drop non-Latin runs) belongs in `engine/piper.js`.
7. **Maintenance**: piper-wasm is a 2024 build of a 2023 phonemizer; onnxruntime-web moves fast. Pin both.

## Next step

Build step 4 as one PR: `extension/engine/piper.js` with its tests, the Worker, the player route and chunk
size, the files under `extension/lib/piper/` with `VERSION.txt` and licences, `WORKERS` in the manifest, and
the GPL-3.0 LICENSE at the repository root. Measure in Chrome and Firefox on a laptop before merging, and
only then decide on the eSpeak data trim and multi-threading in Chrome.
