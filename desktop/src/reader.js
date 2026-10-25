// Reader for web pages and text documents: build paragraphs, then hand them to the
// extension's reader UI (content.js) exactly like its PDF reader does.
import { getDoc } from './store.js';

const $ = (id) => document.getElementById(id);
const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
const params = new URLSearchParams(location.search);

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dt,dd,td,th';
const BOILERPLATE = /\b(subscribe|newsletter|sign up|sign in|log in|cookie|advertisement|share this|follow us)\b/i;

function htmlToDoc(html, fallbackTitle, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (baseUrl) { const b = doc.createElement('base'); b.href = baseUrl; doc.head.prepend(b); }
  let title = doc.title || fallbackTitle, byline = '', root = doc.body;
  const parsed = new Readability(doc.cloneNode(true)).parse();
  if (parsed?.content) {
    title = parsed.title || title;
    byline = parsed.byline || '';
    root = new DOMParser().parseFromString(parsed.content, 'text/html').body;
  }
  const blocks = [...root.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS))
    .map((el) => ({ tag: /^H[1-6]$/.test(el.tagName) ? 'h' : 'p', text: el.textContent.replace(/\s+/g, ' ').trim() }))
    .filter((b) => b.text && !(b.text.length < 140 && BOILERPLATE.test(b.text)));
  const parts = title.split(/\s+[|·•–—]\s+|\s+-\s+/);
  if (parts.length > 1 && parts[0].length >= 12) title = parts[0];
  if (blocks[0]?.tag === 'h' && blocks[0].text.toLowerCase() === title.toLowerCase()) blocks.shift();
  // A "next chapter"/"next page" link: the reader offers to continue there (any site, since
  // downloads go through the main process)
  const next = baseUrl ? danNextLink.find(doc, baseUrl, baseUrl, { sameOrigin: false }) : null;
  return { title, byline, blocks, next };
}

function textToDoc(text, title, kind) {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    if (kind === 'markdown') {
      const h = p.match(/^#{1,6}\s+(.*)$/);
      if (h && !p.includes('\n')) return { tag: 'h', text: h[1] };
      p = p.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`>#]+/g, '');
    }
    return { tag: 'p', text: p.replace(/\s+/g, ' ').trim() };
  }).filter((b) => b.text);
  return { title, byline: '', blocks };
}

let contentLoaded = null;
const loadReader = () => (contentLoaded ??= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'content.js';
  s.onload = resolve;
  s.onerror = () => reject(new Error('Could not load the reader'));
  document.body.append(s);
}));

async function open() {
  let doc, docUrl, docId;
  const url = params.get('url');
  const key = params.get('doc');
  if (url) {
    status('Downloading…');
    const r = await window.danDesktop.fetch(url);
    if (!r.ok) throw new Error(`The site returned HTTP ${r.status}`);
    if (/application\/pdf/i.test(r.contentType)) { location.replace(`pdf-reader.html?url=${encodeURIComponent(url)}`); return; }
    const charset = (r.contentType.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
    let html;
    try { html = new TextDecoder(charset).decode(r.body); } catch { html = new TextDecoder().decode(r.body); }
    doc = /html|xml/i.test(r.contentType) || !r.contentType ? htmlToDoc(html, new URL(url).hostname, r.url || url) : textToDoc(html, new URL(url).pathname.split('/').pop() || url, 'text');
    docUrl = location.href;
    docId = url.split('#')[0];
  } else if (key) {
    const saved = await getDoc(key);
    if (!saved) throw new Error('This document is no longer saved. Open it again from home.');
    doc = saved.kind === 'html' ? htmlToDoc(saved.text, saved.title) : textToDoc(saved.text, saved.title, saved.kind);
    if (saved.pasted) doc.hideTitle = true; // its title is just the opening words
    docUrl = location.href;
    docId = `doc:${key}`;
  } else {
    location.replace('home.html');
    return;
  }
  if (!doc.blocks.length) throw new Error('No readable text was found here.');
  window.__danTtsDoc = doc;
  window.__danTtsDocUrl = docUrl;
  window.__danTtsDocId = docId;
  document.title = `${doc.title} · dan-tts`;
  status(`${doc.blocks.length} paragraphs`);
  await loadReader();
  window.__danTtsStart('page');
  watchClose();
}

// When the reader is closed (Esc / ✕), offer a way back in
function watchClose() {
  setInterval(() => {
    const open = document.querySelector('dan-tts-root')?.shadowRoot?.querySelector('.overlay.open');
    $('closed').hidden = !!open;
  }, 500);
  $('reopen').onclick = (e) => { e.preventDefault(); window.__danTtsStart('page'); };
}

open().catch((err) => { console.error(err); status(err.message, true); $('closed').hidden = false; });
