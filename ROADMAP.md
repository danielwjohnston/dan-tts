# Dan-TTS Roadmap

Future feature ideas, roughly prioritized. Nothing here is committed — just documented for reference.

## Near-Term

- ~~**SRT caption export**~~ — Done
- ~~**Paragraph chunking**~~ — Done: long text is split into paragraphs and synthesized in sequence with a progress bar
- ~~**Batch synthesis**~~ — Done: tester's Batch panel turns `---`-separated texts into one zip of MP3s + SRT captions
- ~~**Improved embed workflow**~~ — Done: Export → Standalone HTML is one file with audio, timings and player inlined
- ~~**Cleaner "Load from URL"**~~ — Done: `/extract_text` drops sidebars, menus and boxes, then reads the block with the most paragraph text when there is no `<main>`/`<article>`
- **"Load from URL" on the Cloudflare Worker** — the Worker's `/extract_text` returns 501, so the button only works against the Render/FastAPI backend
- **Continue to next page** (extension) — near the end of a page that has a "next" link, offer to follow it and keep reading; remember the choice per site. Covers chapter-per-page books and multi-page articles anywhere

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

## Longer-Term / Experimental

- ~~**PDF reading**~~ — Done in the extension for PDFs with a text layer (headers, footers and page numbers stripped, hyphenation rejoined). and scanned/image-only PDFs (on-device text recognition, cached). Next: more recognition languages
- **Book audio** — cache generated audio + word timings per chapter for offline replay; export a book as an audiobook (one MP3 + SRT per chapter); optional separate voice for dialogue
- **Books on the website** — "Load from URL" on a book returns its chapter list, and Batch exports one MP3 per chapter
- **Video generation** — Use ffmpeg to create MP4 videos with synchronized text highlighting (multiple styles: typewriter, split-screen, animated slides)
- ~~**Deployment**~~ — Done: GitHub Pages (front end) + Render free plan (API)
- **CMS integrations** — WordPress shortcode, Ghost embed, static site generator plugins
- **Multi-language support** — Expand beyond en-US voices
- **Custom voice profiles** — Save per-project voice + speed + format preferences
