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
- **Continue to next page** (extension) — near the end of a page that has a "next" link, offer to follow it and keep reading; remember the choice per site. Covers chapter-per-page books and multi-page articles anywhere
- **Edge endpoint health check** — a scheduled job calls the voices list and a short synthesis, and alerts on failure. The engine depends on an unofficial endpoint and a token pinned in `engine/src/drm.js`; CI tests are offline, so nothing else would catch a change
- **Edge terms: personal use only for now** — decided 2026-10-20. The unofficial endpoint and spoofed browser headers stay in personal use; nothing public ships on them. Public release waits on the Azure AI Speech item below
- **Azure AI Speech as the public path** — Microsoft's official speech API, with the same neural voices, word-boundary events (what the highlighting needs), and documented terms. Free tier: 0.5 million characters per month for neural voices. Billing counts every character, spaces and punctuation included. Paid rates are on the Azure pricing calculator, not the public page. Still to do: an engine adapter, and a cost estimate for a whole book

## Medium-Term

- **SSML support** — Allow fine-grained control over pronunciation, pauses, emphasis, and speaking rate
- ~~**Browser extension**~~ — Done: `extension/` reads pages and selections with no server (Chromium browsers and Firefox 140+)
- **Voice comparison** — Synthesize same text with multiple voices side-by-side for easy A/B testing
- **Persistent history** — Save synthesis history to localStorage or a lightweight database instead of session-only
  - Extension side done: the library remembers every page read, with resume position
- **Books** (extension) — treat a long work as its own stored collection, an ebook reader built on the fly. See [`docs/books-design.md`](docs/books-design.md)
  1. `books` store in the extension's IndexedDB; library gets a Books tab (shelf with covers, shelves/tags, "continue listening")
  2. `book.html` reader: contents sidebar, chapter skip, whole-book progress, per-book voice and speed, sleep timer, bookmarks
  3. **Wikisource importer** — on a "versions" page (e.g. *The Time Machine*) pick an edition; fetch its chapter subpages through the MediaWiki API and save the text
  4. **Save as book** for PDFs already opened in the PDF reader
- **EPUB import** — read EPUB files (Wikisource's own export, Project Gutenberg, etc.) into a Book
- **Calibre plugin (v1)** — thin client to a dan-tts server, standard library only. Built in [`calibre-plugin/`](calibre-plugin/): reads EPUB and TXT, synthesizes in chunks in a background job, and attaches MP3 and SRT to the book. Build with `python scripts/build-calibre-plugin.py`, then load `dist/dan_tts_calibre.zip` in Calibre's plugin settings. Verified: offline tests, plugin loads in Calibre 9.16, and a real `add_format` attaches both files. Verified end to end in the Calibre 9.16 GUI on a virtual display: right-click a book, Make audiobook, and the MP3 and SRT attach. This also caught a job-argument bug, fixed in `1c0857a`. Not yet: MOBI/AZW3 via `ebook-convert`, and a per-chunk cancel. Gotchas: `add_format` replaces an existing format by default; the viewer can't show MP3 or SRT; the Render free tier sleeps (30–60 s first request). Study: [`docs/calibre-plugin-feasibility.md`](docs/calibre-plugin-feasibility.md)

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
- **Custom voice profiles** — Save per-project voice + speed + format preferences
