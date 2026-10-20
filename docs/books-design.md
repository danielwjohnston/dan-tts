# Books: design sketch

Status: idea, not started. Tracked in [`ROADMAP.md`](../ROADMAP.md).

## Problem

dan-tts reads one page at a time, and the library keeps one progress entry per URL (`progress:<url>` in
`chrome.storage.local`). A book doesn't fit that model. On Wikisource, for example,
[The Time Machine](https://en.wikisource.org/wiki/The_Time_Machine) is a "versions" page listing six editions, and each
edition is a contents page whose text is split across subpages (`The_Time_Machine_(Heinemann_text)/Chapter_1` …
`Chapter_16`). Reading it today means opening 16 pages by hand, and the library shows 16 unrelated entries.

## Idea

Make a long work a stored object of its own: import it once from its source, keep the text in the extension, and read
it in a dedicated reader, like an ebook app built on the fly. Audio is still generated as you listen.

## Stored book

Lives in a `books` object store in the extension's existing IndexedDB database `dan-tts` (the PDF reader already caches
recognized text there, see `extension/pdf-reader.js`).

```
Book
 ├─ id, title, author, year, edition ("Heinemann text, 1895")
 ├─ source: wikisource | pdf | epub | web-series, plus the original URLs
 ├─ cover (scan title page, or generated)
 ├─ tags/shelf: "Sci-fi", "Reading now", "Finished"…
 ├─ voice + speed for this book (overrides the favourite in chrome.storage.sync)
 ├─ chapters[]: title, paragraphs
 ├─ position: chapter + paragraph + word, time listened
 ├─ bookmarks / highlights / notes
 └─ audio cache (optional): MP3 + word timings per chapter
```

Storing the text means books open instantly, work offline, and don't change if the source page is edited.

## UI

### Library becomes a bookshelf

```
┌ dan-tts ─────────────────────────────────────────── [+ Add book] ┐
│  Books  Pages          Shelf: [All ▾]   Sort: [Recently read ▾] │
│                                                                  │
│  Continue listening                                              │
│  ┌──────┐  The Time Machine · H. G. Wells                        │
│  │cover │  Ch 3 of 16 · 2h 40m left · Aria 1.1×                  │
│  └──────┘  ███████░░░░░░░░░░░░░ 18%            [▶ Resume]         │
│                                                                  │
│  Sci-fi (3)                                                      │
│  [cover] [cover] [cover]                                         │
└──────────────────────────────────────────────────────────────────┘
```

*Pages* is today's list of one-off articles. **+ Add book** takes a URL or a dropped PDF/EPUB; the reader bar also
gets a *Save as book* button.

### Edition picker (Wikisource versions pages)

```
┌──────────────────────────────────────────────────────────┐
│  The Time Machine — H. G. Wells                          │
│  Wikisource has 6 editions. Which one should I read?     │
│  ● Heinemann text (1895)        16 chapters  ★ featured  │
│  ○ Holt text (1895)             12 chapters              │
│  ○ National Observer (1894)      scans only — can't read │
│  ☐ Just read this page instead                           │
│                                   [ Cancel ] [ Read ▶ ]  │
└──────────────────────────────────────────────────────────┘
```

### Book reader (`book.html`)

```
┌──────────────┬───────────────────────────────────────────────────┐
│ Contents     │  III. The Time Traveller Returns                  │
│ ✓ I          │                                                   │
│ ✓ II         │  I think that at that time none of us quite       │
│ ▸ III   40%  │  believed in the Time Machine…                    │
│   IV         │                                                   │
│ Bookmarks 2  │                                                   │
├──────────────┴───────────────────────────────────────────────────┤
│ ⇤ ⏮ ▶ ⏭ ⇥   1.1×  Aria·F (this book)   Ch 3 · 12:04 / 31:20    │
│ ████████████░░░░░░░░░░░░░░░░░  book 18%   💤 Sleep timer   🔖    │
└──────────────────────────────────────────────────────────────────┘
```

⏮/⏭ skip paragraphs, ⇤/⇥ skip chapters. The next chapter's audio is prefetched so playback doesn't pause between
chapters.

## Importers

- **Wikisource** — list an edition's chapter subpages with the MediaWiki API
  (`action=query&list=allpages&apprefix=<edition>/`) or parse its contents page for order, then fetch each chapter's
  rendered text. On a versions page (`{{versions}}` template), offer the edition picker. Editions that exist only as
  scans (`{{ssl}}` links) can't be read.
- **PDF** — *Save as book* from the existing PDF reader, which already rebuilds paragraphs.
- **EPUB** — unzip, follow the spine for chapter order. Wikisource's own export (`ws-export.wmcloud.org`) produces
  EPUBs for any edition.
- **Web series** — follow "next" links, the same logic as the "Continue to next page" roadmap item.

## Order of work

1. `books` store + Books tab.
2. `book.html` reader, reusing the content-script engine and highlighting.
3. Wikisource importer, then *Save as book* for PDFs, then EPUB.
4. Later: per-book audio cache / offline download, audiobook export (one MP3 + SRT per chapter, the Batch zip format),
   dialogue voices.
