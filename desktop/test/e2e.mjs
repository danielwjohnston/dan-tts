// End-to-end test of the desktop app against the live voice service.
//   cd desktop && npm test            (needs a display: on Linux CI use xvfb-run)
// Optional: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs, HTTPS_PROXY to reach the internet.
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const fixtures = join(desktop, '..', 'extension', 'test', 'fixtures');
const { _electron: electron } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { DEFAULT_SERVER } = await import(pathToFileURL(join(desktop, '..', 'engine', 'src', 'server.js')).href); // the app runs a copy of it
const electronPath = createRequire(import.meta.url)('electron'); // path to the binary

const server = createServer((req, res) => {
  const file = req.url.slice(1);
  if (file.endsWith('.pdf')) { res.setHeader('Content-Type', 'application/pdf'); res.end(readFileSync(join(fixtures, file))); return; }
  if (file.endsWith('.epub')) { res.setHeader('Content-Type', 'application/epub+zip'); res.end(readFileSync(join(fixtures, file))); return; }
  // Named fixture pages (the chapter pages); anything else is the article
  const page = /^[\w-]+\.html$/.test(file) && existsSync(join(fixtures, file)) ? file : 'article.html';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(readFileSync(join(fixtures, page)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const userData = mkdtempSync(join(tmpdir(), 'dan-tts-desktop-test-'));
const app = await electron.launch({
  executablePath: electronPath,
  args: [desktop, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  env: { ...process.env, DAN_TTS_USER_DATA: userData, ...(process.env.HTTPS_PROXY ? { DAN_TTS_PROXY: process.env.HTTPS_PROXY } : {}) },
});
const errors = [];
try {
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForLoadState('domcontentloaded');
  check('app window opens on the home page', (await win.title()) === 'dan-tts Reader' && win.url() === 'app://reader/home.html', win.url());

  const sec = await win.evaluate(async () => {
    let fileBlocked = false;
    try { await window.danDesktop.fetch('file:///etc/passwd'); } catch { fileBlocked = true; }
    return { node: typeof require !== 'undefined' || typeof process !== 'undefined', fileBlocked, bridge: Object.keys(window.danDesktop) };
  });
  check('locked down: no Node in the page, only https/http downloads', !sec.node && sec.fileBlocked && sec.bridge.join() === 'fetch', JSON.stringify(sec));

  const shadow = (src) => win.evaluate((s) => new Function('root', s)(document.querySelector('dan-tts-root').shadowRoot), src);
  const waitActive = (timeout = 60000) => win.waitForFunction(() => document.querySelector('dan-tts-root')?.shadowRoot?.querySelector('.w.active'), null, { timeout });
  const advancing = async () => {
    const seen = [];
    for (let i = 0; i < 16; i++) { const v = await shadow(`const a = root.querySelector('.w.active'); return a ? Number(a.dataset.i) : null;`); if (v !== null && v !== seen.at(-1)) seen.push(v); await win.waitForTimeout(150); }
    return seen;
  };

  // 1. Web page by address
  await win.fill('#url', `${origin}/article.html`);
  await win.click('#url-form button');
  await waitActive();
  const article = await shadow(`return root.querySelector('.article').innerText;`);
  const seen = await advancing();
  check('web page: cleaned article is read with highlighting', /Every town has a place/.test(article) && !/newsletter|Cookie settings/i.test(article) && seen.length >= 4, `words ${seen.slice(0, 6).join(',')}`);
  await shadow(`const s = root.querySelector('.voice'); s.dispatchEvent(new Event('focus'));`);
  await win.waitForFunction(() => document.querySelector('dan-tts-root').shadowRoot.querySelectorAll('.voice option').length > 100, null, { timeout: 30000 });
  check('voice picker lists every voice', true, `${await shadow(`return root.querySelectorAll('.voice option').length;`)} voices`);
  await win.keyboard.press('Escape');
  await win.waitForSelector('#closed:not([hidden])', { timeout: 5000 });
  check('closing the reader offers a way back', true);

  // 1b. Continue to the next page: the next chapter's link is found when the page is downloaded
  await win.goto(`app://reader/reader.html?url=${encodeURIComponent(`${origin}/chapter1.html`)}`);
  await waitActive();
  check('a web page with a next link offers it at the end of the text', (await shadow(`return root.querySelector('.nextbox .nexttitle')?.textContent;`)) === 'Next chapter');
  await shadow(`root.querySelector('.nextbox .go').click();`);
  await win.waitForURL((u) => u.searchParams.get('url') === `${origin}/chapter2.html`, { timeout: 20000 });
  await waitActive();
  check('Continue opens the next chapter in the reader and reads it', /behind the atlases/.test(await shadow(`return root.querySelector('.article').innerText;`)), win.url());
  await win.keyboard.press('Escape');

  // 2. Pasted text
  await win.goto('app://reader/home.html');
  await win.fill('#text', 'Pasted text works too. The desktop app reads anything you give it, with every word highlighted as it is spoken.');
  await win.click('#text-form button');
  await waitActive();
  check('pasted text is read', (await advancing()).length >= 3);
  check('pasted text has no spoken title (no repeated opening words)', !(await shadow(`return !!root.querySelector('.article h1');`)));
  await win.waitForTimeout(2500); // progress is saved every ~2 s
  await win.keyboard.press('Escape');

  // 3. PDF by address (text layer) and 4. a scanned PDF from disk (text recognition)
  await win.goto('app://reader/home.html');
  await win.fill('#url', `${origin}/book.pdf`);
  await win.click('#url-form button');
  await waitActive();
  const pdfText = await shadow(`return root.querySelector('.article').innerText;`);
  check('PDF link: paragraphs rebuilt and read', /Paragraph 16 begins here/.test(pdfText) && !/A Novel/.test(pdfText), await win.textContent('#status'));
  await win.keyboard.press('Escape');

  await win.goto('app://reader/home.html');
  await win.setInputFiles('#file', join(fixtures, 'scan.pdf'));
  await waitActive(180000);
  const scanText = await shadow(`return root.querySelector('.article').innerText;`);
  check('scanned PDF from disk: text recognized and read', /The vote was unanimous/.test(scanText) && !/THE QUIET LIBRARY/.test(scanText), await win.textContent('#status'));
  await win.keyboard.press('Escape');

  // 5. Books: an EPUB link, an EPUB file from disk, and an archive.org item
  await win.goto('app://reader/home.html');
  await win.fill('#url', `${origin}/book.epub`);
  await win.click('#url-form button');
  await win.waitForSelector('#chapters li', { timeout: 30000 });
  const toc = (await win.textContent('#toc-view')).replace(/\s+/g, ' ');
  check('EPUB link opens as a book with its chapters', /The Lighthouse Keeper/.test(toc) && /The Storm/.test(toc) && /Morning Light/.test(toc), toc.slice(0, 120));
  await win.click('#chapters li:nth-child(2) a');
  await win.waitForSelector('#article p');
  await win.click('#read');
  await waitActive();
  const chapterText = await shadow(`return root.querySelector('.article').innerText;`);
  check('book chapter is read aloud', /By dawn the sea was calm/.test(chapterText) && !/The wind rose|Chapters/.test(chapterText) && (await advancing()).length >= 3, chapterText.slice(0, 80));
  await win.waitForTimeout(2500);
  await win.keyboard.press('Escape');

  await win.goto('app://reader/home.html');
  await win.setInputFiles('#file', join(fixtures, 'book.epub'));
  await win.waitForSelector('#chapters li', { timeout: 30000 });
  check('EPUB file from disk opens as a book', /book\.html\?file=/.test(win.url()) && (await win.locator('#chapters li').count()) === 2, win.url());

  // archive.org item: archive.org often times out from CI machines, so the app's download
  // handler answers archive.org with canned replies (an item's metadata, then the fixture
  // EPUB). Everything else (book.js, lib/archive.js, the EPUB reader) runs for real.
  const epub = readFileSync(join(fixtures, 'book.epub')).toString('base64');
  await app.evaluate(({ ipcMain, net }, epub) => {
    ipcMain.removeHandler('dan:fetch');
    ipcMain.handle('dan:fetch', async (_e, url) => {
      const reply = (body, contentType) => ({ ok: true, status: 200, url, contentType, body: new Uint8Array(body) });
      if (url === 'https://archive.org/metadata/lighthousekeeper00test') {
        const meta = { metadata: { title: 'The Lighthouse Keeper', creator: 'Test Author' }, files: [{ name: 'lighthouse_keeper.epub', format: 'EPUB' }, { name: 'lighthouse_keeper_lcp.epub', format: 'LCP Encrypted EPUB' }] };
        return reply(Buffer.from(JSON.stringify(meta)), 'application/json');
      }
      if (url === 'https://archive.org/download/lighthousekeeper00test/lighthouse_keeper.epub') return reply(Buffer.from(epub, 'base64'), 'application/epub+zip');
      const res = await net.fetch(url);
      return { ok: res.ok, status: res.status, url: res.url, contentType: res.headers.get('content-type') || '', body: new Uint8Array(await res.arrayBuffer()) };
    });
  }, epub);
  await win.goto('app://reader/book.html?id=lighthousekeeper00test');
  await win.waitForSelector('#chapters li', { timeout: 30000 }).catch(() => {});
  check('archive.org item opens as a book (plain EPUB picked, not the encrypted one)', (await win.locator('#chapters li').count()) === 2 && /The Lighthouse Keeper/.test(await win.textContent('#book-title')), await win.textContent('#toc-status'));

  // 6. Library: everything is listed, and pasted text reopens where it left off
  await win.goto('app://reader/home.html');
  await win.waitForSelector('#library li');
  const lib = (await win.textContent('#library')).replace(/\s+/g, ' ');
  check('library lists the page, both chapters, text, PDFs and book chapter', (await win.locator('#library li').count()) === 7 && /127\.0\.0\.1/.test(lib) && /Chapter One/.test(lib) && /Chapter Two/.test(lib) && /Saved text/.test(lib) && /PDF/.test(lib) && /Book/.test(lib), lib.slice(0, 200));
  await win.locator('#library li', { hasText: 'Saved text' }).locator('a').click();
  await waitActive();
  check('reopening saved text resumes it', /Resumed/.test(await shadow(`return root.querySelector('.status').textContent;`)));

  // 7. Settings: the voice server. The shim keeps chrome.storage.sync in localStorage ("chrome.sync.<key>")
  // and the server's voice list in localStorage "dan.serverVoiceCache"
  const stored = () => win.evaluate(() => ({ server: localStorage.getItem('chrome.sync.server'), voice: localStorage.getItem('chrome.sync.voice'), cache: localStorage.getItem('dan.serverVoiceCache') }));
  await win.goto('app://reader/home.html');
  await win.click('#settings');
  await win.waitForURL('app://reader/settings.html');
  await win.waitForFunction(() => document.getElementById('server').value !== '');
  check('Settings opens from the home screen and shows the default voice server', (await win.inputValue('#server')) === DEFAULT_SERVER && (await win.textContent('#default-url')) === DEFAULT_SERVER && /Settings/.test(await win.title()), await win.inputValue('#server'));
  await win.evaluate(() => { localStorage.setItem('chrome.sync.voice', JSON.stringify('eleven:testvoice01')); localStorage.setItem('dan.serverVoiceCache', JSON.stringify({ at: Date.now(), server: 'x', voices: [] })); });
  await win.fill('#server', 'ftp://example.com');
  await win.click('#save');
  check('an address without http:// or https:// is refused', (await win.evaluate(() => document.getElementById('server').validationMessage)) !== '' && (await stored()).server === null);
  await win.fill('#server', `${origin}/`); // the trailing slash is dropped
  await win.click('#save');
  await win.waitForFunction((o) => localStorage.getItem('chrome.sync.server') === JSON.stringify(o), origin);
  const s1 = await stored();
  check('saving a local server stores it and clears the server voice cache', s1.server === JSON.stringify(origin) && s1.cache === null && s1.voice === '"eleven:testvoice01"' && (await win.inputValue('#server')) === origin, JSON.stringify(s1));
  await win.fill('#server', '');
  await win.click('#save');
  await win.waitForFunction(() => localStorage.getItem('chrome.sync.server') === '""');
  const s2 = await stored();
  check('saving an empty field turns server voices off and resets a provider voice to Aria', s2.server === '""' && s2.voice === '"en-US-AriaNeural"' && /Edge voices only \(voice reset to Aria\)/.test(await win.textContent('#status')), `${JSON.stringify(s2)} status "${await win.textContent('#status')}"`);
  await win.fill('#server', DEFAULT_SERVER);
  await win.click('#save');
  await win.waitForFunction(() => localStorage.getItem('chrome.sync.server') === null);
  check('saving the default leaves the setting unset', (await stored()).server === null);
  await win.click('.topbar a');
  await win.waitForURL('app://reader/home.html');
  check('Settings has a way back home', win.url() === 'app://reader/home.html');

  check('no page errors', errors.length === 0, errors.join('; '));
} catch (e) {
  check('run', false, e.message.split('\n')[0]);
} finally {
  await app.close();
  server.close();
  rmSync(userData, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
