// End-to-end test of the Firefox build against the live voice service:
//   FIREFOX_PATH=/path/to/firefox PUPPETEER_MODULE=/path/to/puppeteer-core node extension/test/e2e-firefox.mjs
// WebDriver can't open moz-extension:// pages, so the test copy gets a small hook in its
// background page that takes commands from this script's local server.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { default: puppeteer } = await import(process.env.PUPPETEER_MODULE || 'puppeteer-core');
const { connectionUrl } = await import(join(root, 'engine', 'src', 'tts.js'));

execFileSync('node', [join(root, 'scripts', 'build-firefox.mjs')], { stdio: 'inherit' });
const ext = mkdtempSync(join(tmpdir(), 'dan-tts-ff-'));
cpSync(join(root, 'dist', 'firefox'), ext, { recursive: true });

// ---- local server: fixture page, command queue for the hook, reports ----
const queue = [];
let waiter = null;
const send = (cmd) => { if (waiter) { waiter(cmd); waiter = null; } else queue.push(cmd); };
const reports = [];
const server = createServer((req, res) => {
  if (req.url === '/control') {
    const reply = (cmd) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(cmd)); };
    if (queue.length) reply(queue.shift()); else { waiter = reply; setTimeout(() => { if (waiter === reply) { waiter = null; reply({ op: 'none' }); } }, 20000); }
    return;
  }
  if (req.url === '/report') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { reports.push(JSON.parse(b)); res.end('ok'); }); return; }
  if (req.url.endsWith('.pdf')) { res.setHeader('Content-Type', 'application/pdf'); res.end(readFileSync(join(here, 'fixtures', req.url.slice(1)))); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end(readFileSync(join(here, 'fixtures', 'article.html')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const m = JSON.parse(readFileSync(join(ext, 'manifest.json')));
m.host_permissions.push('http://127.0.0.1/*');
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(m));
// WebDriver can't see extension tabs, so the PDF reader reports its own state
appendFileSync(join(ext, 'pdf-reader.js'), `
// ---- test reporter (test copy only) ----
setInterval(() => {
  const root = document.querySelector('dan-tts-root')?.shadowRoot;
  fetch('${origin}/report', { method: 'POST', body: JSON.stringify({ pdfReader: {
    src: new URLSearchParams(location.search).get('url'), status: document.getElementById('status').textContent,
    active: root?.querySelector('.w.active')?.textContent || null, text: root?.querySelector('.article')?.innerText.slice(0, 4000) || '' } }) }).catch(() => {});
}, 1000);
`);
appendFileSync(join(ext, 'background.js'), `
// ---- test hook (test copy only) ----
(async function poll() {
  try {
    const cmd = await (await fetch('${origin}/control')).json();
    if (cmd.op === 'read') {
      // Match patterns can't contain ports
      const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
      const t = tabs.find((x) => x.url.endsWith(cmd.path || '/article.html'));
      await startReading(t.id, cmd.mode);
    } else if (cmd.op === 'tabs') {
      await fetch('${origin}/report', { method: 'POST', body: JSON.stringify({ tabs: (await chrome.tabs.query({})).map((x) => x.url) }) });
    } else if (cmd.op === 'storage') {
      await fetch('${origin}/report', { method: 'POST', body: JSON.stringify({ storage: await chrome.storage.sync.get(null) }) });
    }
  } catch (e) { await fetch('${origin}/report', { method: 'POST', body: JSON.stringify({ error: String(e) }) }).catch(() => {}); }
  setTimeout(poll, 50);
})();
`);

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const browser = await puppeteer.launch({
  browser: 'firefox', executablePath: process.env.FIREFOX_PATH, headless: true,
  extraPrefsFirefox: {
    'media.autoplay.default': 0,
    ...(proxy ? { 'network.proxy.type': 1, 'network.proxy.ssl': proxy.hostname, 'network.proxy.ssl_port': Number(proxy.port),
      'network.proxy.http': proxy.hostname, 'network.proxy.http_port': Number(proxy.port), 'network.proxy.no_proxies_on': 'localhost,127.0.0.1' } : {}),
  },
});
try {
  await browser.installExtension(ext);
  check('installs in Firefox', true, await browser.version());
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${origin}/article.html`);

  const shadow = (src, arg) => page.evaluate((s, a) => (new Function('root', 'arg', s))(document.querySelector('dan-tts-root').shadowRoot, a), src, arg);
  const activeWord = () => shadow(`const el = root.querySelector('.w.active'); return el ? [Number(el.dataset.i), el.textContent] : null;`);
  const waitShadow = (cond, timeout) => page.waitForFunction(new Function(`const root = document.querySelector('dan-tts-root')?.shadowRoot; return !!root && (${cond});`), { timeout, polling: 200 });

  // 1. Read page
  send({ op: 'read', mode: 'page' });
  await waitShadow(`root.querySelector('.overlay.open')`, 20000);
  const text = await shadow(`return root.querySelector('.article').innerText;`);
  check('overlay shows the cleaned article', /Every town has a place/.test(text) && !/Subscribe now|newsletter|Cookie settings/i.test(text));
  await waitShadow(`root.querySelector('.w.active')`, 40000);
  const seen = [];
  for (let i = 0; i < 20; i++) { const w = await activeWord(); if (w && w[0] !== seen.at(-1)) seen.push(w[0]); await new Promise((r) => setTimeout(r, 150)); }
  check('audio plays and the highlight advances', seen.length >= 4 && seen.every((v, i) => i === 0 || v > seen[i - 1]), seen.slice(0, 8).join(','));

  // 2. Pause / resume
  await shadow(`root.querySelector('.play').click();`);
  await new Promise((r) => setTimeout(r, 500));
  const paused = await activeWord();
  await new Promise((r) => setTimeout(r, 1000));
  check('pause freezes playback', JSON.stringify(await activeWord()) === JSON.stringify(paused));
  await shadow(`root.querySelector('.play').click();`);
  await new Promise((r) => setTimeout(r, 1500));
  check('resume continues', (await activeWord())?.[0] > paused?.[0]);

  // 3. Keeps playing past Firefox's ~30 s background idle limit
  // (the fixture runs ~40 s at 1×, so sample before it ends)
  await shadow(`root.querySelector('.restart').click();`);
  await new Promise((r) => setTimeout(r, 25000));
  const a1 = await activeWord();
  await new Promise((r) => setTimeout(r, 10000));
  const a2 = await activeWord();
  check('still reading at 35 s (background kept alive past Firefox’s 30 s idle limit)', a1 && a2 && a2[0] > a1[0], `25 s: ${a1?.join(' ')} → 35 s: ${a2?.join(' ')}`);

  // 4. Click a word to jump; speed persists
  const target = await shadow(`const w = [...root.querySelectorAll('.w')].find(e => e.textContent === 'Children'); w.click(); return Number(w.dataset.i);`);
  await waitShadow(`(() => { const el = root.querySelector('.w.active'); return el && Math.abs(Number(el.dataset.i) - ${target}) <= 3; })()`, 30000);
  check('click-to-seek jumps to the word', true, (await activeWord())?.join(' '));
  await shadow(`const s = root.querySelector('.speed'); s.value = '1.5'; s.dispatchEvent(new Event('change'));`);
  await new Promise((r) => setTimeout(r, 300));
  send({ op: 'storage' });
  await new Promise((r) => setTimeout(r, 800));
  check('speed setting persists', reports.some((r) => r.storage?.rate === 1.5), JSON.stringify(reports.at(-1)));

  // 5. Close; read a selection in place
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 300));
  check('Esc closes the reader', await shadow(`return !root.querySelector('.overlay.open');`));
  await page.evaluate(() => { const p = document.querySelectorAll('article p')[2]; const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); });
  send({ op: 'read', mode: 'selection' });
  await page.waitForFunction(() => CSS.highlights?.has('dan-tts-word'), { timeout: 40000, polling: 200 });
  check('selection is highlighted in place', await page.evaluate(() => [...CSS.highlights.get('dan-tts-word')][0].toString().length > 0));
  await page.keyboard.press('Escape');

  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));

  // 6. Websites can't borrow the header rule (the refused attempt logs an expected page error)
  const site = await page.evaluate((url) => new Promise((res) => { const ws = new WebSocket(url); ws.onopen = () => { ws.close(); res('opened'); }; ws.onerror = () => res('refused'); setTimeout(() => res('timeout'), 10000); }), connectionUrl());
  check('websites cannot borrow the header rule', site === 'refused', site);
  // 7. PDFs: a PDF tab opens in dan-tts' reader (text layer, then a scan via text recognition)
  for (const [file, expect, timeout] of [['book.pdf', /Paragraph 8 begins here/, 60000], ['scan.pdf', /The vote was unanimous/, 180000]]) {
    const tab = await browser.newPage();
    await tab.goto(`${origin}/${file}`).catch(() => {});
    send({ op: 'read', path: `/${file}`, mode: 'auto' });
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      last = reports.filter((r) => r.pdfReader?.src?.endsWith(file)).at(-1)?.pdfReader || last;
      if (last?.active && expect.test(last.text)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    check(`${file}: read aloud in Firefox (highlighting "${last?.active}")`, !!last?.active && expect.test(last.text) && !/A Novel|THE QUIET LIBRARY/.test(last.text), last?.status);
    await tab.close().catch(() => {});
  }

  check('no hook errors', !reports.some((r) => r.error), reports.filter((r) => r.error).map((r) => r.error).join('; '));
} catch (e) {
  console.log('ERROR', e.message, '| hook reports:', JSON.stringify(reports));
  results.push({ name: 'run', ok: false });
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
