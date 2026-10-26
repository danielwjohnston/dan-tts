# Spike: an offline voice with word timings (Workstream D)

Date: 2026-10-26. Research only; nothing built yet. Question from `docs/plan.md` §3D: which on-device
engine can read a page with highlighting while the network is off, in the extension (Chrome and Firefox)
and the desktop app, with licensing clean enough for a public listing?

**Decision (owner, 2026-10-26):** the repository is licensed GPL-3.0-or-later and the first offline voice is Piper with the public-domain `en_US-ljspeech-medium` voice. The spike below is being run; results go in `offline-voice-piper-results.md`.

## Short answer

**Build the first slice with Piper** (VITS, ONNX) running in the browser through onnxruntime-web, with
the eSpeak-ng phonemizer compiled to WebAssembly and Piper's own alignment patch for word timings. It is
the only option that today meets every hard constraint at once: it fits Firefox's 200 MB add-on limit
(about 100 MB bundled), runs faster than real time on one CPU thread (Firefox extensions get no
multi-threading), gives native word timings, and runs the same way in Chrome's offscreen document, the
Firefox background page and the Electron window. Its cost is the lowest naturalness of the candidates and
a GPL licence. **Kokoro-82M** is the better-sounding, fully permissive second slice, but it needs WebGPU
(or the desktop app's native runtime) to keep up with real time.

## Candidates

| Engine | Browser runtime | Download | Speed (RTF, lower is faster) | Word timings | Licence (code / voices) | Maintained |
|---|---|---|---|---|---|---|
| **Piper** (piper1-gpl) | onnxruntime-web WASM (14 MB) + eSpeak-ng WASM (19 MB) | medium voice 63 MB, high 114 MB | 0.79 in Firefox on a PC, single thread (2024 figure; newer builds faster); 0.35 native | **Native**: the alignment patch exposes per-phoneme durations; a space phoneme separates words | GPL-3.0 (engine + eSpeak) / per-voice: see "Licensing" | piper-tts 1.8.0 (2026-09); the old rhasspy/piper repo archived 2025-10 |
| **Kokoro-82M** | transformers.js or ORT-web, WASM or WebGPU | q8 92 MB (fp16 163 MB), voices 0.5 MB each | WebGPU 0.23; WASM 1.46 (M2 Air) | **Native**: the "timestamped" ONNX returns per-token durations | Apache-2.0 / Apache-2.0 (training data includes synthetic audio from closed systems; disclose) | weights 2025-01; kokoro-js stale since 2025-05 |
| Supertonic 3 (99M, 31 languages) | ORT-web | 398 MB | about 5× real time on a 16-thread CPU; no browser figure | None: needs a forced aligner | MIT / OpenRAIL-M (use restrictions must flow down) | model 2026-04; repo archived 2026-09 |
| Pocket TTS (Kyutai) | community ports only | 242 MB | 6× real time on two cores | None | MIT / CC BY 4.0 + gated terms | 2026-10 |
| Kitten TTS nano (15M) | community WASM demo | 25 MB | roughly real time in Chrome (unverified method) | None documented | Apache-2.0 (needs eSpeak, GPL) | 2026-10 |
| Chatterbox, Dia, Orpheus, NeuTTS | GPU-class (0.5 to 4 GB) | | | | | not feasible in a browser |

## What the platforms allow

- Chrome Web Store: packages up to 2 GB; all code including WebAssembly must ship in the package (data
  such as model weights may be downloaded at run time, but bundling is cleaner for review).
- Firefox add-ons: packages up to 200 MB; the linter does not parse `.onnx` or `.wasm`, but files over
  5 MB have tripped it for others (check with `web-ext lint`); third-party libraries must be unmodified
  releases, so a self-built eSpeak WASM or a patched model needs a source package. Firefox extension pages
  are not cross-origin isolated, so WebAssembly runs on **one thread**; WebGPU is Windows and Apple Silicon
  only. This is the floor the design must clear.
- Chrome's offscreen document closes after 30 s without audio: run synthesis in a Worker and add the
  `WORKERS` reason. WebGPU should be available there (unverified). Multi-threading needs the
  cross-origin-isolation manifest keys (unverified for offscreen documents).
- Electron (Chromium 152): the same code runs in the window with WebGPU, or `onnxruntime-node` runs the
  model natively in the main process, several times faster; no store limits.
- Precedent: the extension already bundles 6.8 MB of Tesseract WebAssembly.

## How word boundaries would be produced

- **Piper**: patch a voice once (`pip install piper-tts[alignment]`, then
  `python -m piper.patch_voice_with_alignment voice.onnx`). The patched model returns the audio and a
  per-phoneme frame count; frames × 256 samples at 22,050 Hz gives each phoneme's length (11.6 ms
  resolution; the reader ticks every 40 ms). eSpeak keeps a space phoneme between words, so a word's
  boundary is the sum of its phonemes; convert to the reader's 100 ns ticks. eSpeak expands numbers and
  abbreviations, so word counts can differ from the page text: fall back to spreading a sentence's time
  over its words when they do.
- **Kokoro**: the timestamped ONNX returns durations per input token at 40 frames a second; HeadTTS shows
  the whole browser pipeline.
- **Supertonic, Pocket TTS**: no alignment at all; a second model (whisper-tiny word timestamps or a CTC
  aligner) would double the download and the compute. Not for a first slice.

## Licensing, which decides what can be listed

- **The repository has no top-level LICENSE file.** Bundling Piper (GPL-3.0) makes the extension build a
  GPL combined work, so a licence must be chosen before any listing: GPL-3.0 if Piper ships, otherwise a
  permissive one. This is the owner's decision.
- **Piper voices carry their dataset's terms.** `lessac`, the default voice and the base most English
  voices were fine-tuned from (`ryan`, `amy`, `kusal`, `alan`, `alba`, `aru`, `vctk`, `sam`, `joe`,
  `hfc_*`), uses the Blizzard 2013 Lessac data: research only, no commercial use, redistribution needs
  consent. Clean, from-scratch, public-domain voices: `en_US-ljspeech` (medium 63.5 MB, high 114 MB),
  `en_US-kristin`, `en_US-norman`, `en_GB-cori` (high); `en_US-john` is public domain fine-tuned from
  kristin. A voice trained with `voice-training/` should start from a clean checkpoint (ljspeech or
  kristin, not lessac) and say so in its model card.
- The npm packages `@diffusionstudio/piper-wasm` and `phonemizer` are labelled MIT and Apache-2.0 but
  contain eSpeak-ng builds: treat them as GPL.
- **Kokoro** is the cleanest stack if the English-only G2P from HeadTTS is used instead of eSpeak.
- Piper's documentation describes the project as intended for personal use and research; carry that
  wording into the disclosure even though it is not a licence term.

## The first spike (about a day)

1. Voice: `en_US-ljspeech-medium` (public domain). Patch it with the alignment tool and confirm in Python
   that per-phoneme alignments come back.
2. Packages: `onnxruntime-web` 1.30.0 and `@diffusionstudio/piper-wasm` 1.0.0 (phonemizer), under
   `extension/lib/piper/` like Tesseract.
3. `extension/engine/piper.js` exporting `synthesizePiper(text, { voice })` → `{ audio, boundaries,
   contentType: 'audio/wav' }`: phonemes → ids, ORT inputs `input`, `input_lengths`, `scales`, outputs
   audio and frames; group frames by the space phoneme; boundaries in ticks mapped to the page's words.
   Voice id `piper:ljspeech` (ids carry their provider); route it in the player next to the server voices.
4. Run it in the offscreen document inside a Worker, unchanged in the Firefox player and the Electron
   window. Measure load time, speed per chunk (one thread and, in Chrome, several), memory, and highlight
   drift by ear. Lint the Firefox zip.

Exit criteria: faster than 0.7× real time on one thread on a 2020-class laptop; first audio under about
2 s per chunk with the existing next-chunk prefetch; highlight drift under about 100 ms; a page reads with
the network off. If Kokoro is preferred, the half-day variant is to run HeadTTS's browser demo on the target
hardware and read its speed figures; its durations path already exists.

## Risks

- Licence: GPL combined work and no project licence; voice provenance; Firefox's unmodified-library rule.
- Speed on low-end and ARM laptops and in Firefox (one thread); Kokoro's dependence on WebGPU, which is
  missing on Linux for most users.
- Word mapping when eSpeak expands numbers, abbreviations, hyphenation or OCR noise; chunk boundaries
  versus the phonemizer's sentence splitting.
- Chrome closing the offscreen document while a chunk synthesizes; memory with the model loaded (unmeasured).
- Maintenance: piper-wasm dates from 2024; kokoro-js is stale; sherpa-onnx dropped its phonemizer;
  Supertonic is archived.
- Unverified: WebGPU in offscreen documents, OPFS in extension pages, onnxruntime-web accepting the
  patched model's untyped second output, Firefox's handling of large `.wasm` files.

## Sources

Piper: [alignment docs](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/ALIGNMENTS.md),
[voices and their licences](https://huggingface.co/rhasspy/piper-voices),
[Blizzard 2013 Lessac licence](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html),
[browser and WASM reports](https://github.com/rhasspy/piper/issues/352),
[@diffusionstudio/piper-wasm](https://www.npmjs.com/package/@diffusionstudio/piper-wasm),
[sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases).
Kokoro: [model card](https://huggingface.co/hexgrad/Kokoro-82M),
[timestamped ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped),
[HeadTTS](https://github.com/met4citizen/HeadTTS), [kokoro-js](https://www.npmjs.com/package/kokoro-js).
Others: [Supertonic](https://github.com/supertone-inc/supertonic), [Pocket TTS](https://github.com/kyutai-labs/pocket-tts),
[KittenTTS](https://github.com/KittenML/KittenTTS), [Picovoice on-device TTS benchmark](https://picovoice.ai/blog/on-device-tts/).
Platforms: [Chrome Web Store publishing](https://developer.chrome.com/docs/webstore/publish),
[Chrome remote-code policy](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements),
[chrome.offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen),
[cross-origin isolation for extensions](https://developer.chrome.com/docs/extensions/mv3/cross-origin-isolation),
[Firefox add-on submission limits](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[Firefox add-on policies](https://extensionworkshop.com/documentation/publish/add-on-policies/),
[Firefox bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477),
[WebGPU implementation status](https://github.com/gpuweb/gpuweb/wiki/implementation-status).
