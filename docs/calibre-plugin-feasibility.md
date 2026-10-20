# Feasibility study: dan-tts as a Calibre plugin

Status: study only. No plugin code has been written or run.

## Question

Can dan-tts run inside Calibre, so a user can select a book in the library and get
narrated audio (MP3, optionally with SRT captions) without leaving Calibre?

## Short answer

**Feasible, with a clear recommended path.** The hard parts are not the plugin shell,
which is well documented and stable. They are (1) packaging the TTS dependency into
Calibre's embedded Python, and (2) the fact that the Microsoft Edge voice endpoint is
unofficial. The recommended v1 is a thin Calibre plugin that calls a dan-tts server
over HTTP, which needs no third-party Python packages at all.

## What a Calibre plugin is

- A zip file containing Python 3 code, with a `plugin-import-name-<name>.txt` marker and
  a plugin class in `__init__.py`. Calibre loads it at startup and installs it through
  Preferences → Plugins → Load plugin from file.
- Plugin types relevant here:
  - **InterfaceAction**: adds a toolbar button and menu entries that act on selected books.
    This is the right type for "Read aloud" / "Make audiobook".
  - **FileTypePlugin / Conversion**: not needed; we do not have to convert formats.
  - **Metadata / Store / Catalog**: not relevant.
- Calibre's GUI is Qt. The calibre release notes mention Qt 6.10 (release 9.2.1), so
  current releases run on Qt 6. Plugins should import Qt through `from qt.core import ...`,
  which the manual's examples use; that route has worked across Qt5 and Qt6 builds since
  calibre 5.13. The plugin should still avoid Qt where it can, since the built-in job and
  dialog helpers cover most needs.
- Multi-file plugins need an empty `plugin-import-name-<name>.txt` marker in the zip, and
  extra modules are imported via `calibre_plugins.<name>`. The GUI class (`InterfaceAction`)
  should live in its own module, separate from `__init__.py`, because calibre also runs a
  CLI that must not load GUI code. Source: calibre manual, "Writing your own plugins"
  (https://manual.calibre-ebook.com/creating_plugins.html).
- `__init__.py` boilerplate (from the manual's Interface Plugin Demo, fetched directly):

  ```python
  from calibre.customize import InterfaceActionBase

  class InterfacePluginDemo(InterfaceActionBase):
      name = 'Interface Plugin Demo'
      description = 'An advanced plugin demo'
      supported_platforms = ['windows', 'osx', 'linux']
      author = 'Kovid Goyal'
      version = (1, 0, 0)
      minimum_calibre_version = (0, 7, 53)
      actual_plugin = 'calibre_plugins.interface_demo.ui:InterfacePlugin'
  ```

- `ui.py` holds the `InterfaceAction` subclass with `action_spec` and `genesis()`, which
  sets the toolbar icon and connects `self.qaction.triggered` to the handler. The manual
  notes that calibre has no central shortcut management, so pick an unused shortcut or
  `None`.
- Docs version: the manual page fetched is for calibre 9.16.0, so the study targets the
  current release line rather than 8.x.
- Python version: calibre's `pyproject.toml` declares `requires-python = ">=3.14"`
  (https://github.com/kovidgoyal/calibre/blob/master/pyproject.toml). A plugin should be
  written and tested against that interpreter. The build-time version function was not
  located, so this is the declared minimum rather than a confirmed embedded build.
- `db.add_format` (from `src/calibre/db/cache.py` on calibre master):
  - Signature: `add_format(self, book_id, fmt, stream_or_path, replace=True, run_hooks=True, dbapi=None)`.
  - `replace` defaults to **True**, so adding an MP3 format to a book that already has one
    overwrites it silently unless the plugin passes `replace=False`.
  - With `replace=False` and an existing file, it returns `False` before any write.
  - It writes through the backend, records the format and its size, updates the last-modified
    time, dispatches a `format_added` event, and queues a full-text search job.
  - With `run_hooks=True` (the default), plugin import and post-import hooks run. Plugin
    code that adds audio should decide explicitly whether to run them.
  - Backend write (`src/calibre/db/backend.py`): the destination is `<book folder>/<name>.<fmt>`;
    the folder is created if missing; a stream is written to a temp file and renamed over the
    destination, or written in place if that fails; a path source uses `os.replace`. The backend
    does not update the format or size tables. The caller (`cache.py`) does that.
- Long work runs as a background job through Calibre's job system (`ThreadedJob` /
  `BaseJob`), so the GUI stays responsive and progress shows in Calibre's job manager.
  Synthesis of a whole book is minutes long, so this is required, not optional.

## Getting text out of a book

Three options, in order of preference:

1. **Calibre's own converter.** Run `ebook-convert book.epub out.txt` (or call the
   conversion API) on the selected book's best format. Gives clean plain text, handles
   EPUB, MOBI, AZW3, PDF (with weaker results), and others. Adds a few seconds per book
   and depends on the user having Calibre's conversion tools, which they always do inside
   Calibre.
2. **Direct EPUB parsing.** EPUB is a zip of XHTML. Read the spine in order and strip tags.
   Fast and dependency-free, but misses edge cases (DRM, odd manifests).
3. **Calibre's `db` API** to find the format file path, then either of the above.

Recommendation: option 1 for the first version, with option 2 as a fast path for EPUB.

The existing `/extract_text` and paragraph chunking (`static/chunk-text.js`, port to
Python if needed) already cover the chunking logic that the server uses today.

## Getting audio

### Option A: thin client to the existing dan-tts server (recommended for v1)

- The plugin POSTs chunks to `/synthesize_with_timing` (or `/synthesize`) on a configurable
  server URL and writes the returned MP3s.
- Uses only the Python standard library (`urllib`). No packages to bundle, no platform
  wheels, works on Windows, macOS and Linux with whatever Calibre ships.
- Needs a running dan-tts server: the user's own machine, a LAN host, or the Render
  deployment already in the repo. Render's free tier sleeps, so a first request can take
  30–60 s; the plugin should show this in its progress UI.
- Keeps all the fragile Microsoft-protocol code in one place, the server, which is already
  tested.

### Option B: run the TTS engine inside Calibre's Python

- Port `engine/src/tts.js` and `drm.js` to Python, or bundle `edge-tts` into the plugin zip.
- `edge-tts` depends on `aiohttp`, which has compiled extensions. Calibre's bundled Python
  is not something a plugin can `pip install` into, so this means bundling per-platform
  wheels (Windows, macOS x86/arm64, Linux), roughly three or four zips. Doable, but it
  multiplies release work and is the main reason to avoid it for v1.
- Alternative to avoid `aiohttp`: a minimal WebSocket client on the standard library's
  `ssl` and `socket` modules. Feasible, but more code to own.
- Benefit: fully offline from any server, no dan-tts deployment needed.

### Option C: the browser engine via a helper process

Not recommended. It adds a Node runtime requirement for no real gain over A.

## Output inside Calibre

- **MP3 per chunk, then concatenate.** Concatenating MP3 frames is safe when all chunks
  share the same bitrate and sample rate; the server already emits 48 kbps MP3 from the
  Edge service, so this works without ffmpeg. This avoids needing ffmpeg on the user's
  machine.
- **Attach to the book.** Calibre's library accepts extra format files per book
  (`db.add_format`), so the MP3 can be stored as an `MP3` format on the book record.
  Calibre does not play audio itself, so the plugin should also offer "Save audio to
  folder" and "Open in default player".
- **SRT captions.** The server already returns word timings and can export SRT. Store the
  `.srt` next to the audio, or as a format if the user wants it in the library.
- **M4B audiobooks** (chapter markers) would need ffmpeg or a Python tagging library and
  are out of scope for v1.

## Plugin UX sketch

1. Select one or more books, click **Read aloud** on the toolbar.
2. Dialog: voice (from `/voices`), speed/format, output (library format or folder),
   server URL (saved in plugin prefs).
3. Background job: extract text → chunk → synthesize each chunk → concatenate → attach.
   Progress shown per chunk; cancellable between chunks.
4. Done notification with the file location. Failures list the book and the step that failed.

## Risks and open questions

| Risk | Severity | Notes |
| --- | --- | --- |
| Microsoft Edge TTS endpoint is unofficial and can change or block requests | High | Already a risk for the whole project (see README notes). A plugin that ships to others multiplies the blast radius. Mitigation: the server is the single point of change; keep the server version pinned in the plugin's docs. |
| Terms of service for the Edge read-aloud service | High | The project spoofs browser headers and derives a token (`drm.js`). Needs a human decision on whether public distribution is acceptable before any release. |
| Calibre API changes between major versions | Medium | Pin a minimum Calibre version; test on current release. |
| Bundling `aiohttp` for Option B | Medium | Avoided by Option A. |
| Large books: hundreds of chunks, long runs | Medium | Chunk-level progress and resume (write chunks to a temp dir and skip completed ones). |
| Scanned PDFs (no text layer) | Medium | Same limitation as the browser extension; needs OCR, out of scope. |
| DRM-protected formats | Low for v1 | Calibre cannot read DRM either; the plugin should just report it. |
| Text quality from `ebook-convert` (footnotes, page headers) | Low | Reuse the extension's header/footer stripping and hyphenation rules where possible. |

## Effort estimate (rough, one developer)

| Work item | Estimate |
| --- | --- |
| Plugin skeleton: toolbar action, prefs, job runner, install and reload | 2–3 days |
| Text extraction via `ebook-convert` + EPUB fast path | 1–2 days |
| Server client, chunking, progress, cancel/resume | 2–3 days |
| Attach MP3 and SRT to library, folder export | 1 day |
| Testing across Calibre versions and OSes, packaging, README | 3–4 days |
| **Total for v1 (Option A)** | **about 2 weeks** |

Option B adds roughly one more week for packaging and per-platform testing.

## Testing plan

- Unit tests for chunking and MP3 concatenation (pure Python, runnable with pytest, no Calibre).
- Calibre's `calibre-debug -e` runs a plugin's code in the Calibre environment for manual
  smoke tests; `calibre-debug -g` launches the GUI with plugin logs.
- The existing server tests already stub Edge TTS, so the plugin tests can point at a
  stub HTTP server and run offline.

## Recommendation

1. Build **Option A** as v1: a thin Calibre plugin that talks to a dan-tts server, with
   MP3 and SRT attached to the book.
2. Before any public release, get a decision on the Edge endpoint's terms and on whether
   users may point the plugin at a public server.
3. Only consider Option B if users need a fully offline plugin and the packaging cost is
   justified.

## Items not verified in this study

- Edge terms of service. This is a user decision before any public release. The audio path
  itself is covered by the repo's earlier live checks (see `engine/README.md`) and the
  voices endpoint returned HTTP 200 from the session on 2026-10-20.
- What the viewer displays for an attached MP3 or SRT. `ebook-viewer` launches on the book's
  `.txt`, `.mp3` and `.srt` files without crashing (it ran until the 30 s timeout each time),
  but the window can't be seen headlessly, so the rendered content is unverified. Calibre's
  viewer is for book formats; a plugin should open audio with the system player instead of
  relying on the viewer.

## Runtime checks (Calibre 9.16.0 installed in the sandbox, 2026-10-20)

- Installed with the official `linux-installer.sh` to `/opt/calibre` (needed `libegl1` and
  `libopengl0` from apt).
- Bundled interpreter: `calibre-debug -c "import sys; print(sys.version)"` prints
  **Python 3.14.8**. This confirms the declared `requires-python = ">=3.14"` at runtime.
- `calibredb add_format` in a throwaway library:
  - Attaching `.mp3` and `.srt` to a book with `.txt` succeeds; all three formats are listed.
  - A second `.mp3` with default options **replaces** the existing file in place.
  - With `--dont-replace` it prints "A MP3 file already exists for book ..., not replacing" and
    leaves the file unchanged.
  - Format files are written into the book's folder under the library, as the backend source
    describes.
  - `calibredb search 'formats:"=MP3"'` and `'formats:"=SRT"'` both match the book.
  - `calibredb export --single-dir` writes `.mp3`, `.srt`, `.txt` and `.opf` side by side.
  - `ebook-convert` on the book's `.txt` still produces an EPUB, so attaching audio does not
    break conversion.
  - Full-text search for a word from the book returned nothing. The library's full-text index
    was not built in this test, so this does not show a problem with the attached formats.
