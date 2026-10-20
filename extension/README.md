# dan-tts Reader (browser extension)

Read any web page, or just the part you select, aloud in Microsoft's natural voices, with each word highlighted as it's spoken. **No server, no account, free.** The extension talks to the voice service directly using the [dan-tts engine](../engine/).

Works in **Chrome, Edge, Brave, Arc, Vivaldi and Opera** (Chromium 116+). Firefox and Safari aren't supported yet.

## Install (about a minute)

1. Download this repo: **Code → Download ZIP** on GitHub, then unzip it. Or `git clone` it.
2. Open your browser's extensions page: `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and choose the **`extension`** folder inside the repo.
5. Optional: pin **dan-tts Reader** to the toolbar from the puzzle-piece menu.

To update later, pull or download the repo again and click the ↻ reload button on the extension's card.

## Use

| To… | Do this |
|---|---|
| Read the whole page | Click the toolbar icon, press **Alt+Shift+R**, or right-click the page → **Read this page aloud** |
| Read part of a page | Select text, then press **Alt+Shift+R** or right-click → **Read selection aloud** |

**Reading a page** opens a clean, distraction-free view of the article (menus, ads and sidebars are removed). It highlights each word and scrolls along with the reading.

- **Click any word** to jump there.
- **Space** plays or pauses, **← →** move between paragraphs, **Esc** closes.

**Reading a selection** highlights words right on the page.

The control bar has previous/next, play/pause, **speed (0.75×–3×)**, and a **voice picker with 322 voices in dozens of languages**. Your speed and voice are remembered.

**Resume and library.** Every page you read keeps its place, and reopening the reader there picks up where you stopped ("Resumed" shows in the bar). **⟲** starts over from the beginning. Right-click the toolbar icon and choose **Open library** to see everything you've read, with progress and when you last read it. If a page's text has changed since you last read it, the reader starts from the top. Progress is stored only in your browser.

Change the shortcut at `chrome://extensions/shortcuts`.

## Permissions, and why

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Lets the reader into a tab only when you click, use the menu or press the shortcut. It doesn't run on every page you visit. |
| Access to `speech.platform.bing.com` | The voice service. |
| `declarativeNetRequest` | The service only answers requests that look like Edge's built-in Read Aloud, so the extension sets two request headers. The rule applies **only to the extension's own requests**: websites can't use it. |
| `offscreen` | Plays audio in a hidden extension page, so a site's security settings can't block playback. |
| `contextMenus`, `storage` | The right-click items, plus remembering your voice, speed and reading positions. These stay in your browser. |

Nothing you read is sent anywhere except the text itself, which goes to Microsoft's voice service to be spoken.

## Limitations
- Pages the browser protects (`chrome://` pages, the Web Store, the built-in PDF viewer) can't be read. The toolbar icon briefly shows ✕.
- Pages built entirely in JavaScript are read once they've loaded, since the extension reads what's on screen. Very unusual layouts may extract imperfectly; selecting the text you want always works.
- Long pages are read paragraph by paragraph, with the next one prepared while the current one plays. Jumping far ahead takes a second or two to load.

## Development
- `background.js` handles entry points, the header rule and message relay. `offscreen.js` runs the engine and plays audio. `content.js` handles extraction, the reader UI, highlighting and saving progress. `library.html` and `library.js` are the library page.
- `engine/` and `lib/chunk-text.js` are **copies**. Edit `engine/src/` or `static/chunk-text.js`, then run `node scripts/sync-extension.mjs`. CI fails if they drift.
- `lib/Readability.js` is Mozilla's [Readability](https://github.com/mozilla/readability) 0.6.0 (Apache 2.0, license alongside).
- Tests: `node --test extension/test/align.test.js` (offline), and `node extension/test/e2e.mjs` (needs Playwright and network access; loads the extension into Chromium and reads a test page with the live voice service).
