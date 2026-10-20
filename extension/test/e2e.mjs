// End-to-end test against the live voice service: node extension/test/e2e.mjs
// Loads the extension into Chromium, reads a fixture page, and checks highlighting,
// controls, selection mode and that websites can't borrow the header rule.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const extSrc = join(here, '..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { connectionUrl } = await import(join(extSrc, 'engine', 'tts.js'));

// Test copy: grant 127.0.0.1 so scripting works without a real toolbar click (activeTab)
const ext = mkdtempSync(join(tmpdir(), 'dan-tts-ext-'));
cpSync(extSrc, ext, { recursive: true, filter: (p) => !p.includes(`${extSrc}/test`) });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json')));
manifest.host_permissions.push('http://127.0.0.1/*');
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(readFileSync(join(here, 'fixtures', 'article.html'))); }).listen(0);
const origin = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const ctx = await chromium.launchPersistentContext('', {
  executablePath: process.env.CHROMIUM_PATH || undefined,
  headless: true,
  args: ['--headless=new', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required',
    // Behind an HTTPS proxy (CI sandboxes), keep the local fixture server off the proxy
    ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [])],
});
try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/article.html`);
  if (process.env.DEBUG) console.log('page:', await page.title(), JSON.stringify((await page.textContent('body')).slice(0, 120)));

  const read = (mode) => sw.evaluate(async ({ mode, origin }) => {
    const [t] = await chrome.tabs.query({ url: `${origin}/*` });
    await startReading(t.id, mode);
  }, { mode, origin });
  const shadow = (fn, arg) => page.evaluate(([src, a]) => (new Function('root', 'arg', src))(document.querySelector('dan-tts-root').shadowRoot, a), [fn, arg]);
  const activeWord = () => shadow(`const el = root.querySelector('.w.active'); return el ? [Number(el.dataset.i), el.textContent] : null;`);
  const status = () => shadow(`return root.querySelector('.status').textContent;`);

  // 1. Read page → overlay with clean article
  await read('page');
  await page.waitForFunction(() => document.querySelector('dan-tts-root')?.shadowRoot.querySelector('.overlay.open'), null, { timeout: 10000 });
  const articleText = await shadow(`return root.querySelector('.article').innerText;`);
  check('overlay shows the article', articleText.includes('Every town has a place') && articleText.includes('The vote was unanimous'));
  check('Readability removed nav, sidebar, newsletter and footer',
    !/Subscribe now|Trending|newsletter|Cookie settings/i.test(articleText), (articleText.match(/.{0,40}(Subscribe now|Trending|newsletter|Cookie settings).{0,40}/i) || [''])[0]);

  // 2. Highlighting advances through words
  await page.waitForFunction(() => document.querySelector('dan-tts-root').shadowRoot.querySelector('.w.active'), null, { timeout: 30000 });
  const seen = new Set();
  for (let i = 0; i < 25; i++) { const w = await activeWord(); if (w) seen.add(w[0]); await page.waitForTimeout(120); }
  const order = [...seen];
  check('word highlight advances', order.length >= 5 && order.every((v, i) => i === 0 || v > order[i - 1]), `tokens ${order.slice(0, 8).join(',')}…`);
  if (process.env.SCREENSHOT_DIR) {
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'reader-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'reader-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
  }
  check('status shows paragraph progress', /^\d+ \/ \d+$/.test(await status()), await status());

  // 3. Pause stops the highlight; resume continues
  await shadow(`root.querySelector('.play').click();`);
  await page.waitForTimeout(400);
  const pausedAt = await activeWord();
  await page.waitForTimeout(900);
  check('pause freezes playback', JSON.stringify(await activeWord()) === JSON.stringify(pausedAt));
  await shadow(`root.querySelector('.play').click();`);
  await page.waitForTimeout(1200);
  check('resume continues', (await activeWord())?.[0] > pausedAt?.[0]);

  // 4. Click a word in a later paragraph → playback jumps there
  const target = await shadow(`const w = [...root.querySelectorAll('.w')].find(e => e.textContent === 'unanimous.'); w.click(); return Number(w.dataset.i);`);
  await page.waitForFunction((t) => { const el = document.querySelector('dan-tts-root').shadowRoot.querySelector('.w.active'); return el && Number(el.dataset.i) >= t - 6; }, target, { timeout: 30000 });
  check('click-to-seek jumps to the clicked word', true, `target token ${target}, now at ${(await activeWord())?.join(' ')}`);

  // 5. Speed is saved
  await shadow(`const s = root.querySelector('.speed'); s.value = '2'; s.dispatchEvent(new Event('change'));`);
  await page.waitForTimeout(300);
  check('speed persists to settings', (await sw.evaluate(() => chrome.storage.sync.get('rate'))).rate === 2);

  // 6. Voice list loads (all languages)
  await shadow(`root.querySelector('.voice').dispatchEvent(new Event('focus'));`);
  await page.waitForFunction(() => document.querySelector('dan-tts-root').shadowRoot.querySelectorAll('.voice option').length > 100, null, { timeout: 20000 });
  check('voice picker lists all voices', true, `${await shadow(`return root.querySelectorAll('.voice option').length;`)} voices`);

  // 6b. Resume: reopen the page → continues near where we were, not from the top
  await page.waitForTimeout(2600); // progress is saved every ~2 s
  const before = (await activeWord())?.[0] ?? 0;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await read('page');
  await page.waitForFunction((t) => { const el = document.querySelector('dan-tts-root').shadowRoot.querySelector('.w.active'); return el && Number(el.dataset.i) >= t - 25; }, before, { timeout: 30000 });
  const resumedStatus = await status();
  check('reopening resumes where you left off', /Resumed/.test(resumedStatus), `was at token ${before}, status "${resumedStatus}", now ${(await activeWord())?.join(' ')}`);
  await shadow(`root.querySelector('.restart').click();`);
  await page.waitForFunction(() => { const el = document.querySelector('dan-tts-root').shadowRoot.querySelector('.w.active'); return el && Number(el.dataset.i) < 10; }, null, { timeout: 30000 });
  check('⟲ starts over from the beginning', true, (await activeWord())?.join(' '));

  // 6c. Library lists the page with its progress
  const extId = new URL(sw.url()).host;
  const lib = await ctx.newPage();
  await lib.goto(`chrome-extension://${extId}/library.html`);
  await lib.waitForSelector('#list li', { timeout: 5000 });
  const libText = await lib.textContent('#list');
  check('library lists the page with progress', libText.includes('The Quiet Library') && /127\.0\.0\.1 · \d+% · paragraph 1 of 1/.test(libText), libText.replace(/\s+/g, ' ').trim().slice(0, 120));
  await lib.click('#list li .remove');
  await lib.waitForSelector('#empty:not([hidden])', { timeout: 5000 });
  check('library item can be removed', true);
  await lib.close();
  await page.bringToFront();

  // 7. Close, then read a selection in place
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc closes the reader', await shadow(`return !root.querySelector('.overlay.open') && root.querySelector('.bar').classList.contains('hidden');`));
  await page.evaluate(() => { const p = document.querySelectorAll('article p')[2]; const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await read('selection');
  await page.waitForFunction(() => CSS.highlights.has('dan-tts-word'), null, { timeout: 30000 });
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'selection.png') });
  const hl = await page.evaluate(() => [...CSS.highlights.get('dan-tts-word')][0].toString());
  check('selection is highlighted in place', /^[\w,.]+$/.test(hl), `current word "${hl}"`);
  check('no overlay in selection mode', await shadow(`return !root.querySelector('.overlay.open');`));
  await page.keyboard.press('Escape');

  // 8. Security: a website can't use the extension's header rule
  const siteAttempt = await page.evaluate((url) => new Promise((res) => {
    const ws = new WebSocket(url);
    ws.onopen = () => { ws.close(); res('opened'); };
    ws.onerror = () => res('refused');
    setTimeout(() => res('timeout'), 10000);
  }), connectionUrl());
  check('websites cannot borrow the header rule', siteAttempt === 'refused', siteAttempt);

  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
