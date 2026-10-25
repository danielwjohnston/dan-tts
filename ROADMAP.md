# Dan-TTS Roadmap

Future feature ideas, roughly prioritized. Nothing here is committed — just documented for reference.

## Near-Term

- ~~**SRT caption export**~~ — Done
- ~~**Paragraph chunking**~~ — Done: long text is split into paragraphs and synthesized in sequence with a progress bar
- ~~**Batch synthesis**~~ — Done: tester's Batch panel turns `---`-separated texts into one zip of MP3s + SRT captions
- ~~**Improved embed workflow**~~ — Done: Export → Standalone HTML is one file with audio, timings and player inlined
- ~~**Cleaner "Load from URL"**~~ — Done: `/extract_text` drops sidebars, menus, boxes, MediaWiki chrome (Wikisource's header, "[edit]" links, categories), hidden elements and form controls, then reads `<main>` or `<article>` when present, else the cleaned `<body>`, with blank lines between paragraphs. The Python server and the Worker follow the same rules
- ~~**"Load from URL" on the Cloudflare Worker**~~ — Done: `worker/src/extract.js`, a dependency-free extractor with the Python server's limits and messages, plus sidebar/menu/box, MediaWiki and hidden-element stripping
- ~~**Test speech on the deployed Worker**~~ — Done (2026-10-25): `/synthesize` and `/synthesize_with_timing` return real audio and word timings from Cloudflare's servers
- ~~**Make the Worker the tester's default API**~~ — Done: the tester defaults to the Worker, uses its own server when served by one, and greys out the formats the Worker can't produce
- ~~**One Cloudflare deploy path**~~ — Done: Cloudflare's Git builds only; the Actions deploy workflow is gone
- ~~**Update `worker/README.md`**~~ — Done
- **Skip the Python install in Cloudflare builds** — a dashboard setting, so it can't be done from the repo: add the build variable `SKIP_DEPENDENCY_INSTALL` = `1` (steps in `worker/README.md`). Saves about 10 s per build
- ~~**Desktop app releases**~~ — Done: pushing a `desktop-v<version>` tag publishes a GitHub Release with the installers. Auto-update builds on this
- ~~**Books in the desktop app**~~ — Done: "Find books" on the home screen, and EPUB links and files open as books
- ~~**Open any EPUB link or file**~~ — Done: paste an EPUB link into the Books search box, or open an EPUB file, in the extension and the desktop app
- ~~**Run the extension's end-to-end tests in CI**~~ — Done: CI runs the Chromium and Firefox tests on every change
- ~~**Continue to next page**~~ — Done: a page with a same-site "next" link offers it at the end of the text; "Always on this site" continues on its own. In the extension and the desktop app
- ~~**Edge endpoint health check**~~ — Done: `.github/workflows/edge-health.yml` runs `scripts/edge-health.mjs` every six hours (voice list and a short synthesis, from Node and through the Worker) and keeps a GitHub issue open while it fails
- **Decide Edge terms for public release** — written decision on whether the unofficial endpoint and spoofed browser headers are acceptable for public distribution. Gates the Calibre plugin release

## Medium-Term

- **SSML support** — Allow fine-grained control over pronunciation, pauses, emphasis, and speaking rate
- ~~**Browser extension**~~ — Done: `extension/` reads pages and selections with no server (Chromium browsers and Firefox 140+)
- ~~**Desktop app**~~ — Done: `desktop/` (Electron) reads web pages, PDFs, scans, text files and pasted text, for Windows, macOS and Linux
- **Voice comparison** — Synthesize same text with multiple voices side-by-side for easy A/B testing
- **Persistent history** — Save synthesis history to localStorage or a lightweight database instead of session-only
  - Extension side done: the library remembers every page read, with resume position
- **Books** (extension) — treat a long work as its own stored collection, an ebook reader built on the fly. See [`docs/books-design.md`](docs/books-design.md)
  1. `books` store in the extension's IndexedDB; library gets a Books tab (shelf with covers, shelves/tags, "continue listening")
  2. `book.html` reader: contents sidebar, chapter skip, whole-book progress, per-book voice and speed, sleep timer, bookmarks
  3. **Wikisource importer** — on a "versions" page (e.g. *The Time Machine*) pick an edition; fetch its chapter subpages through the MediaWiki API and save the text
  4. **Save as book** for PDFs already opened in the PDF reader
- **EPUB import** — read EPUB files (Wikisource's own export, Project Gutenberg, etc.) into a Book
  - Started: the Books page reads archive.org EPUBs chapter by chapter, with resume
- **Page screenshots → book** (Kindle and other locked readers) — drop a folder of page images (from your own capture script) into the PDF reader or desktop app and recognize them directly, skipping the print-to-PDF step. Capturing pages stays your own script: dan-tts won't sign in to Amazon or get around DRM
- **Keep the Firefox add-on installed** — Firefox only keeps signed add-ons. Sign the build as an unlisted add-on in CI (`web-ext sign`, needs free addons.mozilla.org API keys as repository secrets) and attach the `.xpi` to releases
- **Desktop auto-update** — after releases exist: check the latest release on start and offer to update (`electron-updater`)
- **Phone** — the reader as an installable web app (PWA) that appears in the phone's Share menu, so "Share → dan-tts" reads an article. Needs the Worker (or another server) for page downloads and voice headers, since a web page can't set them itself
- **Calibre plugin (v1)** — thin client to a dan-tts server, using only the Python standard library. Reads the book's text via `ebook-convert`, synthesizes in chunks with progress and cancel, and attaches MP3 and SRT to the book. Gotchas: Calibre's `add_format` replaces an existing format by default; the viewer can't show MP3 or SRT, so open audio in the system player; the Render free tier sleeps (30–60 s first request). Study: [`docs/calibre-plugin-feasibility.md`](docs/calibre-plugin-feasibility.md)

## Voice Training (in-house voice, PR #18)

Prep tools exist (`voice-training/`). Everything below is open. Ordered by what unblocks the next step.

**Blocked on a decision**
- **Consent wording and legal review.** The recording page's consent text is a DRAFT. Get it reviewed for every region it may reach. Current text says permission is irrevocable once recordings are used for training.
- **Recording storage and upload.** Preferred direction: process clips live and discard the audio. Needs an endpoint in `app/` that extracts training features, stores only those, and deletes the audio.
- **Country gate.** `BLOCKED_COUNTRIES` in `voice-training/collect/index.html` is empty and the country is self-reported. Fill it in once the legal review is done.
- **Single voice vs. multi-speaker.** A pilot of a single contributor's voice is simpler and is the recommended first step. Multi-speaker needs far more data and more compute.
- **Hosting.** Decide whether the recording page goes to GitHub Pages or stays private.

**Needs hardware or a real run**
- **Run `voice-training/train.sh` on a GPU machine** against a real Piper checkout. Only the validation stage has been dry-run. Check the Python version, PyTorch/CUDA install, checkpoint download, and a real epoch count (the script uses 100 as a placeholder).
- **Test the recording page with a real microphone.** Check that browser recording and the 22050 Hz WAV conversion work, and that the multi-file download isn't blocked by the browser.
- **Pilot with 5–10 volunteers.** Each reads a few dozen sentences. Use it to check recording quality, the consent flow, and whether the model learns usable speech before scaling.

**Needs investigation**
- **Word timings for highlighting.** Check whether Piper's per-phoneme durations can drive word-level highlighting, or whether a forced aligner is needed.
- **Licensing.** Piper's current code is GPL-3.0-or-later and depends on eSpeak-ng. Confirm what that means before shipping anything built on it.
- **Licensed corpora as a starting point.** Evaluate public speech datasets (e.g. LJSpeech, LibriTTS) and their licenses as a way to train without new recruitment.

**Later**
- **Provider abstraction.** Add a provider layer in `engine/src/` and `app/main.py` so a trained Piper voice sits alongside Edge and the hosted options.
- **Hosted alternatives** (Polly, Google Cloud TTS) as fallbacks if Edge's unofficial endpoint breaks.

## Longer-Term / Experimental

- ~~**PDF reading**~~ — Done in the extension for PDFs with a text layer (headers, footers and page numbers stripped, hyphenation rejoined). and scanned/image-only PDFs (on-device text recognition, cached). Next: more recognition languages
- **Book audio** — cache generated audio + word timings per chapter for offline replay; export a book as an audiobook (one MP3 + SRT per chapter); optional separate voice for dialogue
- **Books on the website** — "Load from URL" on a book returns its chapter list, and Batch exports one MP3 per chapter
- **Calibre plugin, offline engine** — bundle the TTS engine into the Calibre plugin so it works without a server. Needs per-platform `aiohttp` wheels (or a stdlib WebSocket client). Only worth it if the thin client isn't enough
- **Video generation** — Use ffmpeg to create MP4 videos with synchronized text highlighting (multiple styles: typewriter, split-screen, animated slides)
- ~~**Deployment**~~ — Done: GitHub Pages (front end) + Render free plan (API), and Cloudflare Workers (front end + API in one Worker, `wrangler.jsonc`)
- **Other formats on the Worker** — the Worker returns MP3 only; M4A/OGG/FLAC need ffmpeg, which only the Render backend has. Options: ffmpeg compiled to WebAssembly, or send those requests to Render
- **Decide: GitHub Pages or Cloudflare for the front end** — both now host the same site. Keeping both costs nothing; Cloudflare alone means one address for site and API
- **CMS integrations** — WordPress shortcode, Ghost embed, static site generator plugins
- **Multi-language support** — Expand beyond en-US voices
- **Code-signed desktop builds** — removes the Windows SmartScreen and macOS "unidentified developer" warnings. Costs money (an Apple Developer account is about $99/year; Windows signing is a paid certificate or service), so only worth it if others use the app
- **Custom voice profiles** — Save per-project voice + speed + format preferences
