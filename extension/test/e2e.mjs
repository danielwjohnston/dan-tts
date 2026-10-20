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

const pdfs = {}; // filled after launch: generated with Chromium so no binaries live in the repo
const server = createServer((req, res) => {
  const name = req.url.slice(1);
  if (pdfs[name]) { res.setHeader('Content-Type', 'application/pdf'); res.end(pdfs[name]); return; }
  res.setHeader('Content-Type', 'text/html'); res.end(readFileSync(join(here, 'fixtures', 'article.html')));
}).listen(0);
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
  let [first] = ctx.serviceWorkers(); if (!first) first = await ctx.waitForEvent('serviceworker');
  const extId = new URL(first.url()).host;
  // MV3 workers stop when idle and restart on demand, and other components (the PDF
  // viewer) have workers too, so always look ours up fresh
  const worker = async () => ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${extId}/`))
    || (await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().startsWith(`chrome-extension://${extId}/`) }));
  const sw = { evaluate: async (fn, arg) => (await worker()).evaluate(fn, arg) };
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

  // 9. PDFs: a PDF tab opens in dan-tts' reader with headers/page numbers stripped
  const maker = await ctx.newPage();
  const para = (n) => '<p>' + ('Paragraph ' + n + ' begins here. ' + 'The library on Elm Street had tall windows and creaking floors, and nobody was ever in a hurry there. ').repeat(4) + 'It ended with a hyphen&shy;ated word.</p>';
  await maker.setContent('<html><body style="font: 12pt Georgia; width: 5.5in"><h1 style="font-size:24pt">The Quiet Library</h1>' + Array.from({ length: 12 }, (_, i) => para(i + 1)).join('') + '</body></html>');
  pdfs['book.pdf'] = await maker.pdf({ format: 'Letter', displayHeaderFooter: true, margin: { top: '1in', bottom: '1in' },
    headerTemplate: '<div style="font-size:9px;width:100%;text-align:center">The Quiet Library — A Novel</div>',
    footerTemplate: '<div style="font-size:9px;width:100%;text-align:center"><span class="pageNumber"></span></div>' });
  // A "scan": each page is only a picture of text (with a running header and page number)
  const scanPage = (n, body) => `<div style="width:816px;height:1056px;padding:72px;box-sizing:border-box;font:16pt Georgia;background:#fff;position:relative">
    <div style="text-align:center;font-size:11pt">THE QUIET LIBRARY</div><p style="margin-top:40px;line-height:1.5">${body}</p>
    <div style="position:absolute;bottom:48px;width:672px;text-align:center;font-size:11pt">${n}</div></div>`;
  const scanBodies = [
    'Every town has a place where time slows down. In ours, it was the library on Elm Street, with its tall windows and creaking floors.',
    'Children came after school to read comics in the corner. Retirees argued gently about crossword clues. Nobody was ever in a hurry.',
    'The vote was unanimous. The library stayed open, and the floors kept creaking, exactly as they should.',
  ];
  const imgs = [];
  for (let i = 0; i < scanBodies.length; i++) {
    await maker.setViewportSize({ width: 816, height: 1056 });
    await maker.setContent(`<html><body style="margin:0">${scanPage(i + 1, scanBodies[i])}</body></html>`);
    imgs.push((await maker.screenshot({ type: 'png' })).toString('base64'));
  }
  await maker.setContent(`<html><body style="margin:0">${imgs.map((b) => `<img src="data:image/png;base64,${b}" style="width:8.5in;height:11in;display:block;break-after:page">`).join('')}</body></html>`);
  pdfs['scan.pdf'] = await maker.pdf({ width: '8.5in', height: '11in', margin: { top: 0, bottom: 0, left: 0, right: 0 } });
  await maker.setContent('<html><body><svg width="600" height="800"><rect width="600" height="800" fill="#eee"/><circle cx="300" cy="300" r="120" fill="#888"/></svg></body></html>');
  pdfs['blank.pdf'] = await maker.pdf({ format: 'Letter' });
  await maker.close();

  const pdfTab = await ctx.newPage();
  await pdfTab.goto(`${origin}/book.pdf`).catch(() => {}); // the viewer may not "load" like a page
  const readerPromise = ctx.waitForEvent('page', { predicate: (p) => p.url().includes('pdf-reader.html'), timeout: 15000 });
  await sw.evaluate(async ({ origin }) => {
    const [t] = await chrome.tabs.query({ url: `${origin}/book.pdf` });
    await startReading(t.id, 'auto');
  }, { origin });
  const reader = await readerPromise;
  const readerErrors = [];
  reader.on('pageerror', (e) => readerErrors.push(e.message));
  if (process.env.DEBUG) {
    reader.on('console', (m) => console.log('reader console:', m.type(), m.text().slice(0, 200)));
    setTimeout(async () => console.log('reader status:', await reader.textContent('#status').catch((e) => e.message), '| bar:', await reader.evaluate(() => document.querySelector('dan-tts-root')?.shadowRoot.querySelector('.status')?.textContent).catch((e) => e.message)), 8000);
  }
  await reader.waitForFunction(() => document.querySelector('dan-tts-root')?.shadowRoot.querySelector('.w.active'), null, { timeout: 60000 });
  const pdfText = await reader.evaluate(() => document.querySelector('dan-tts-root').shadowRoot.querySelector('.article').innerText);
  check('PDF tab opens in the dan-tts reader and plays', reader.url().includes(encodeURIComponent(`${origin}/book.pdf`)));
  check('PDF headers and page numbers are stripped', pdfText.startsWith('The Quiet Library') && !/A Novel/.test(pdfText) && !/^\s*\d+\s*$/m.test(pdfText));
  const pdfParas = await reader.evaluate(() => [...document.querySelector('dan-tts-root').shadowRoot.querySelectorAll('.article p')].map((p) => p.textContent));
  check('PDF paragraphs rebuilt, hyphenation rejoined', pdfParas.length === 12 && pdfParas.every((t, i) => t.startsWith(`Paragraph ${i + 1} begins`) && t.endsWith('It ended with a hyphenated word.')),
    `${pdfParas.length} paragraphs; last ends "${(pdfParas.at(-1) || '').slice(-40)}"`);
  check('no errors in the PDF reader', readerErrors.length === 0, readerErrors.join('; '));
  await reader.keyboard.press('Escape');

  // Local file picker
  const local = await ctx.newPage();
  await local.goto(`chrome-extension://${extId}/pdf-reader.html`);
  if (process.env.DEBUG) {
    local.on('console', (m) => console.log('local console:', m.type(), m.text().slice(0, 240)));
    local.on('pageerror', (e) => console.log('local error:', e.message));
    const tick = setInterval(async () => { const t = await local.textContent('#status').catch(() => null); if (t === null) clearInterval(tick); else console.log('local status:', t.slice(0, 140)); }, 10000);
  }
  const tmpPdf = join(ext, 'local-test.pdf');
  writeFileSync(tmpPdf, pdfs['book.pdf']);
  await local.setInputFiles('#file', tmpPdf);
  await local.waitForFunction(() => document.querySelector('dan-tts-root')?.shadowRoot.querySelector('.overlay.open'), null, { timeout: 30000 });
  check('local PDF files open from the picker', /12 paragraphs|13 paragraphs/.test(await local.textContent('#status')), await local.textContent('#status'));
  await local.keyboard.press('Escape');

  // Scanned (image-only) PDF: text is recognized, cleaned, then read
  writeFileSync(tmpPdf, pdfs['scan.pdf']);
  await local.reload();
  await local.setInputFiles('#file', tmpPdf);
  await local.waitForFunction(() => document.querySelector('dan-tts-root')?.shadowRoot.querySelector('.w.active'), null, { timeout: 180000 });
  const scanText = await local.evaluate(() => document.querySelector('dan-tts-root').shadowRoot.querySelector('.article').innerText);
  check('scanned PDFs are recognized and read', /text recognized from scans/.test(await local.textContent('#status'))
    && /Every town has a place where time slows down/.test(scanText) && /The vote was unanimous/.test(scanText), (await local.textContent('#status')));
  check('scan headers and page numbers are stripped', !/THE QUIET LIBRARY/.test(scanText) && !/^\s*[123]\s*$/m.test(scanText), JSON.stringify(scanText.slice(0, 100)));
  await local.keyboard.press('Escape');
  // A second open of the same scan uses the cache (no recognition step)
  await local.reload();
  const t0 = Date.now();
  await local.setInputFiles('#file', tmpPdf);
  await local.waitForFunction(() => /paragraphs/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('recognized text is cached for next time', Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  await local.keyboard.press('Escape');
  // An image with no text at all gets a clear message
  writeFileSync(tmpPdf, pdfs['blank.pdf']);
  await local.reload();
  await local.setInputFiles('#file', tmpPdf);
  await local.waitForFunction(() => /No readable text/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  check('PDFs with no text at all explain why', true);
  await local.close();

  const lib2 = await ctx.newPage();
  await lib2.goto(`chrome-extension://${extId}/library.html`);
  await lib2.waitForSelector('#list li');
  const lib2Text = (await lib2.textContent('#list')).replace(/\s+/g, ' ');
  check('library lists PDFs (web and local)', /PDF · 127\.0\.0\.1/.test(lib2Text) && /local file/.test(lib2Text), lib2Text.slice(0, 160));
  await lib2.close();

  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
