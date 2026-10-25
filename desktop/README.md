# dan-tts Reader (desktop app)

A desktop app for Windows, macOS and Linux that reads **web pages, PDFs (including scanned ones), EPUB books, text, Markdown and HTML files, and pasted text** aloud. It uses Microsoft's natural voices with word-by-word highlighting. **No server, no account, free.** It's the same reader as the [browser extension](../extension/), in its own window.

- Paste a link, drop a file, or paste text.
- **Books:** find free books on archive.org, or open any EPUB link or file, and read it chapter by chapter.
- Click any word to jump there. Speed runs from 0.75× to 3×, and there are 322 voices in dozens of languages.
- **Library with resume:** everything you read keeps its place.
- **Continue to the next page:** a page with a "next" link (a book read chapter by chapter, a multi-page article) offers it at the end of the text, and can continue on its own per site. Unlike the extension, the app follows such links to other sites too, since it downloads pages itself.
- Scanned PDFs, such as your own page captures, are recognized on your computer the first time and saved after that.

## Install

1. On GitHub, open **Releases** (right side of the repo page) and download the file for your system from the latest **dan-tts Reader** release. Between releases, the newest builds are under **Actions** → **Desktop app** → the latest green run → **Artifacts** (kept for 30 days):
   - **Windows:** `dan-tts-reader-Windows`. It has an installer (`dan-tts Reader Setup 0.1.0.exe`) and a portable `.exe` that runs without installing.
   - **macOS:** `dan-tts-reader-macOS`, a `.dmg`.
   - **Linux:** `dan-tts-reader-Linux`, an `.AppImage`. Run `chmod +x` on it, then run it.
2. **These builds aren't code-signed** (signing certificates cost money), so the system will warn the first time:
   - **Windows SmartScreen:** click **More info** → **Run anyway**.
   - **macOS:** right-click the app → **Open** → **Open**. Or allow it under **System Settings → Privacy & Security**.
3. **Use a personal computer, not a work-managed one.** Security tools like CrowdStrike can flag or block unsigned apps that download content and make network connections, and you don't want a security alert on a work machine.

## Publish a release

1. Bump `"version"` in `desktop/package.json` and merge it.
2. Either push a tag for that commit, `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0` (the tag must match the version), or on GitHub open **Actions** → **Desktop app** → **Run workflow** on `main` with **Publish a GitHub Release** ticked, which creates the tag for you.
3. The workflow tests, builds all three systems, and publishes a GitHub Release with the installers attached.

## Run from source

```bash
cd desktop
npm install
npm start
```

## How it works
- `main.js` is the Electron main process. It does two things a web page can't:
  1. It adds the request headers Microsoft's voice service expects, only for `speech.platform.bing.com`. This is the desktop equivalent of the extension's header rule.
  2. It downloads web pages and PDFs on the window's behalf, `http`/`https` only.
- The window runs the extension's reader code unchanged: `content.js`, `offscreen.js`, `pdf-reader.*`, `book.*` and `lib/`. `src/chrome-shim.js` stands in for the `chrome.*` extension APIs. `scripts/sync-desktop.mjs` assembles `app/` from `../extension` and `src/` before every start, test and build, so fixes made to the extension reach the app automatically.
- **Locked down:** context isolation, sandbox, no Node.js in the window, and a strict Content-Security-Policy. The only bridge to the main process is `danDesktop.fetch(url)` for `http`/`https` addresses. Every permission request (camera, microphone and so on) is denied, and links to the web open in your normal browser.
- Your library, settings and saved text stay on your computer, in the app's data folder.

## Test

```bash
cd desktop
npm install --no-save playwright
xvfb-run -a npm test       # Linux; on Windows/macOS just: npm test
```

The test drives the real app window against the live voice service (18 checks). It covers the lockdown, a web page, continuing to its next chapter, pasted text, a PDF link, a scanned PDF from disk, an EPUB link and file, an archive.org item (with canned archive.org replies, since archive.org often times out from CI machines), the voice list, the library and resume. CI runs it on every change, then builds the Windows, macOS and Linux installers.

## Known limitations
- Builds are unsigned, so you'll see the first-run warning above.
- No auto-update yet: download the newest release to update.
