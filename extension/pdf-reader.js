// PDF reader page: extract text with pdf.js, rebuild paragraphs, then hand them to the
// same reader UI the content script uses on web pages (overlay, highlighting, resume).
import * as pdfjs from './lib/pdfjs/pdf.min.mjs';
import Tesseract from './lib/tesseract/tesseract.esm.min.js';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const bar = $('progress');
const setStatus = (text, error = false) => { statusEl.textContent = text; statusEl.classList.toggle('error', error); };
const setProgress = (f) => { bar.style.display = f === null ? 'none' : 'block'; bar.firstElementChild.style.width = `${Math.round((f || 0) * 100)}%`; };

let contentLoaded = null;
function loadReader() {
  // content.js is a classic script that sets up the reader UI on load
  contentLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'content.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the reader'));
    document.body.appendChild(s);
  });
  return contentLoaded;
}

// ---- OCR for scanned (image-only) PDFs ----
// Results are cached in IndexedDB per document, so a scanned book is recognized once.
const idb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('dan-tts', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('ocr');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function ocrCache(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('ocr', value === undefined ? 'readonly' : 'readwrite');
    const req = value === undefined ? tx.objectStore('ocr').get(key) : tx.objectStore('ocr').put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function ocrPages(doc, cacheKey) {
  const cached = await ocrCache(cacheKey).catch(() => null);
  if (cached) return cached;
  setStatus('Scanned PDF: loading text recognition…');
  // Surface engine failures instead of hanging on "loading…"
  let failEngine;
  const engineFailed = new Promise((_, reject) => { failEngine = reject; });
  const guard = (p) => Promise.race([p, engineFailed]);
  const worker = await guard(Tesseract.createWorker('eng', 1, {
    workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
    corePath: chrome.runtime.getURL('lib/tesseract/tesseract-core-simd-lstm.wasm.js'),
    // The English language data ships with the extension (lib/tesseract/eng.traineddata.gz), so
    // nothing is downloaded: a stalled CDN fetch used to leave the reader on "loading…" for good
    langPath: chrome.runtime.getURL('lib/tesseract'),
    gzip: true,
    cacheMethod: 'none', // local already; don't copy 5 MB into IndexedDB
    workerBlobURL: false, // extension CSP doesn't allow blob: workers
    errorHandler: (e) => failEngine(new Error(`text recognition failed: ${e?.message || e}`)),
  }));
  try {
    const pages = [];
    const started = Date.now();
    for (let i = 1; i <= doc.numPages; i++) {
      const left = i > 1 ? Math.round(((Date.now() - started) / (i - 1)) * (doc.numPages - i + 1) / 1000) : null;
      setStatus(`Recognizing text: page ${i} of ${doc.numPages}${left !== null ? ` (about ${left < 90 ? `${left} s` : `${Math.round(left / 60)} min`} left)` : ''}… This only happens once per PDF.`);
      setProgress((i - 1) / doc.numPages);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 2000 / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const { data } = await guard(worker.recognize(canvas, {}, { blocks: true }));
      pages.push((data.blocks || []).flatMap((b) => b.paragraphs || [])
        .filter((p) => p.confidence >= 30 && p.text.trim())
        .map((p) => p.text.trim()));
      page.cleanup();
    }
    await ocrCache(cacheKey, pages).catch(() => {});
    return pages;
  } finally {
    await worker.terminate();
  }
}

async function readPdf(data, { title, url, id }) {
  setStatus('Opening PDF…');
  setProgress(0);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    setStatus(`Reading page ${i} of ${doc.numPages}…`);
    setProgress(i / doc.numPages);
    pages.push((await (await doc.getPage(i)).getTextContent()).items);
  }
  let blocks = danPdfText.pagesToBlocks(pages);
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);
  let scanned = false;
  if (chars < 40 * doc.numPages && chars < 400) {
    // No text layer: it's a scan. Recognize the text from the page images.
    scanned = true;
    blocks = danPdfText.ocrPagesToBlocks(await ocrPages(doc, `${id}:${doc.numPages}`));
    if (!blocks.length) { setProgress(null); setStatus('No readable text was found in this scanned PDF.', true); return; }
  }
  setProgress(null);
  // PDF title metadata is often junk ("about:blank", "Microsoft Word - draft.docx", "untitled")
  const metaTitle = (meta?.info?.Title || '').trim();
  const junk = !metaTitle || /^(about:blank|untitled|document\d*|microsoft (word|powerpoint)\b.*|.*\.(docx?|pptx?|pdf|indd|tex))$/i.test(metaTitle) || /^[a-z]+:\/\//i.test(metaTitle);
  let docTitle = junk ? '' : metaTitle;
  // Otherwise the first heading is the title; don't read it twice
  if (blocks[0]?.tag === 'h' && (!docTitle || blocks[0].text.toLowerCase() === docTitle.toLowerCase())) docTitle = blocks.shift().text;
  docTitle ||= title;
  window.__danTtsDoc = { title: docTitle, byline: meta?.info?.Author || '', blocks };
  window.__danTtsDocUrl = url;
  window.__danTtsDocId = id;
  document.title = `${docTitle} · dan-tts`;
  setStatus(`${doc.numPages} pages · ${blocks.length} paragraphs${scanned ? ' · text recognized from scans' : ''}`);
  await loadReader();
  window.__danTtsStart('page');
}

// ---- Local files ----
const fileInput = $('file');
$('pick').onclick = (e) => { e.stopPropagation(); fileInput.click(); };
$('drop').onclick = () => fileInput.click();
$('drop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
fileInput.onchange = () => { if (fileInput.files[0]) openFile(fileInput.files[0]); };
for (const ev of ['dragenter', 'dragover']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
  if (f) openFile(f); else setStatus('That isn’t a PDF.', true);
});

async function openFile(file) {
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    // Local files can't be reopened by URL, so the library links back here; the id keeps
    // each file's progress separate
    await readPdf(data, { title: file.name.replace(/\.pdf$/i, ''), url: chrome.runtime.getURL('pdf-reader.html'), id: `file:${file.name}:${file.size}` });
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open that PDF: ${err.message}`, true);
  }
}

// ---- PDFs from the web: pdf-reader.html?url=… ----
const src = new URLSearchParams(location.search).get('url');
async function openUrl() {
  $('allow').hidden = true;
  setStatus('Downloading PDF…');
  let res;
  try {
    res = await fetch(src);
  } catch (err) {
    // No host permission (or the site blocks it): offer to grant access for this site
    const origin = new URL(src).origin;
    if (/^https?:/.test(origin)) {
      setStatus(`dan-tts needs permission to download PDFs from ${new URL(src).hostname}.`, true);
      $('allow').hidden = false;
      $('allow-btn').onclick = async () => {
        if (await chrome.permissions.request({ origins: [`${origin}/*`] })) openUrl();
      };
    } else {
      setStatus(src.startsWith('file:')
        ? 'To read local PDFs opened in the browser, turn on “Allow access to file URLs” for dan-tts at chrome://extensions, or choose the file above.'
        : `Couldn't download the PDF: ${err.message}`, true);
    }
    return;
  }
  if (!res.ok) { setStatus(`Couldn't download the PDF (HTTP ${res.status}).`, true); return; }
  try {
    const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'PDF').replace(/\.pdf$/i, '');
    // Library links reopen this reader page, which loads the PDF and resumes
    await readPdf(new Uint8Array(await res.arrayBuffer()), { title: name, url: chrome.runtime.getURL(`pdf-reader.html?url=${encodeURIComponent(src)}`), id: src.split('#')[0] });
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't read that PDF: ${err.message}`, true);
  }
}
if (src) openUrl();

// Desktop app: a file picked on its home page is handed over through IndexedDB
const handoff = new URLSearchParams(location.search).get('handoff');
if (handoff && window.danDesktop) {
  import('./store.js').then(({ takeHandoff }) => takeHandoff(handoff)).then((item) => {
    if (item) openFile(new File([item.data], item.name, { type: item.type }));
    else setStatus('That file is no longer available. Choose it again.', true);
  });
}
