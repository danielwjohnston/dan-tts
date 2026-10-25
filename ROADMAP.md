# Dan-TTS Roadmap

Future feature ideas, roughly prioritized. Nothing here is committed — just documented for reference.

## Near-Term

- ~~**SRT caption export**~~ — Done
- ~~**Paragraph chunking**~~ — Done: long text is split into paragraphs and synthesized in sequence with a progress bar
- ~~**Batch synthesis**~~ — Done: tester's Batch panel turns `---`-separated texts into one zip of MP3s + SRT captions
- ~~**Improved embed workflow**~~ — Done: Export → Standalone HTML is one file with audio, timings and player inlined
- **Cleaner "Load from URL"** — `/extract_text` reads the whole `<body>` when a page has no `<main>`/`<article>`, so site chrome (e.g. Wikisource's sidebar and header box) gets read aloud. Use Readability-style extraction like the extension does
- **"Load from URL" on the Cloudflare Worker** — the Worker's `/extract_text` returns 501, so the button only works against the Render/FastAPI backend
- **Test speech on the deployed Worker** — `/health` and `/voices` work at `dan-tts.macdaddydwj.workers.dev`, but `/synthesize` hasn't been tried there yet. Microsoft's voice service may treat Cloudflare's servers differently (see `worker/README.md`). Run one synthesis from the tester
- **Make the Worker the tester's default API** — `tester.html` still defaults to `https://dan-tts.onrender.com`, which sleeps when idle. Once the speech test passes, default to the Worker; when the tester is served by the Worker itself, use its own address
- **One Cloudflare deploy path** — the dashboard's Git builds already deploy every push to `main`, and `.github/workflows/deploy-worker.yml` would deploy again if its secrets were added. Decide which to keep (Git builds are simpler) and remove the other
- **Update `worker/README.md`** — its setup steps (API token, GitHub secrets, Actions) predate the Git-connected deploy and the combined site + API Worker in the root `wrangler.jsonc`
- **Skip the Python install in Cloudflare builds** — each build runs `pip install -r requirements.txt` (about 10s) because `requirements.txt` is at the repo root; the Worker doesn't use it. Turn it off with a build variable in the dashboard (check Cloudflare's docs for the current name)
- ~~**Desktop app releases**~~ — Done: pushing a `desktop-v<version>` tag publishes a GitHub Release with the installers. Auto-update builds on this
- ~~**Books in the desktop app**~~ — Done: "Find books" on the home screen, and EPUB links and files open as books
- ~~**Open any EPUB link or file**~~ — Done: paste an EPUB link into the Books search box, or open an EPUB file, in the extension and the desktop app
- ~~**Run the extension's end-to-end tests in CI**~~ — Done: CI runs the Chromium and Firefox tests on every change
- **Continue to next page** (extension) — near the end of a page that has a "next" link, offer to follow it and keep reading; remember the choice per site. Covers chapter-per-page books and multi-page articles anywhere
- **Edge endpoint health check** — a scheduled job calls the voices list and a short synthesis, and alerts on failure. The engine depends on an unofficial endpoint and a token pinned in `engine/src/drm.js`; CI tests are offline, so nothing else would catch a change
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
