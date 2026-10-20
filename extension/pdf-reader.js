// PDF reader page: extract text with pdf.js, rebuild paragraphs, then hand them to the
// same reader UI the content script uses on web pages (overlay, highlighting, resume).
import * as pdfjs from './lib/pdfjs/pdf.min.mjs';

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
  const blocks = danPdfText.pagesToBlocks(pages);
  const chars = blocks.reduce((n, b) => n + b.text.length, 0);
  setProgress(null);
  if (chars < 40 * doc.numPages && chars < 400) {
    setStatus('This PDF looks like scanned images with no text layer, so there is nothing to read yet. (Text recognition for scans is planned.)', true);
    return;
  }
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
  setStatus(`${doc.numPages} pages · ${blocks.length} paragraphs`);
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
