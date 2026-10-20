// Home: open a link, a file or pasted text, and the library of everything read.
import { handOff, saveDoc, deleteDoc } from './store.js';

const $ = (id) => document.getElementById(id);
const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
const isPdf = (name) => /\.pdf($|[?#])/i.test(name);

// ---- Links ----
$('url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  let url = $('url').value.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  location.href = isPdf(url) ? `pdf-reader.html?url=${encodeURIComponent(url)}` : `reader.html?url=${encodeURIComponent(url)}`;
});

// ---- Files ----
async function openFile(file) {
  try {
    if (file.type === 'application/pdf' || isPdf(file.name)) {
      location.href = `pdf-reader.html?handoff=${await handOff(file)}`;
      return;
    }
    if (file.size > 20 * 1024 * 1024) throw new Error('That file is over 20 MB');
    const text = await file.text();
    const kind = /\.html?$/i.test(file.name) || file.type === 'text/html' ? 'html' : /\.(md|markdown)$/i.test(file.name) ? 'markdown' : 'text';
    const key = await saveDoc({ title: file.name.replace(/\.[^.]+$/, ''), text, kind });
    location.href = `reader.html?doc=${key}`;
  } catch (err) {
    status(`Couldn't open that file: ${err.message}`, true);
  }
}
$('pick').onclick = () => $('file').click();
$('file').onchange = () => { if ($('file').files[0]) openFile($('file').files[0]); };
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, () => $('drop').classList.remove('over'));
document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) openFile(f); });

// ---- Pasted text ----
$('text-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) { status('Paste some text first.', true); return; }
  const title = text.split(/\s+/).slice(0, 8).join(' ').replace(/[.,;:!?]+$/, '');
  location.href = `reader.html?doc=${await saveDoc({ title, text, kind: 'text', pasted: true })}`;
});

// ---- Library (same data the reader writes: chrome.storage.local "progress:*") ----
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  for (const [secs, name] of [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}
function describe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'app:') {
      const inner = u.searchParams.get('url');
      if (u.pathname.endsWith('/pdf-reader.html')) return inner ? `PDF · ${new URL(inner).hostname}` : 'PDF on this computer (choose it again to resume)';
      if (inner) return new URL(inner).hostname.replace(/^www\./, '');
      return 'Saved text';
    }
    return u.hostname.replace(/^www\./, '');
  } catch { return url; }
}
async function renderLibrary() {
  const all = await chrome.storage.local.get(null);
  const items = Object.entries(all).filter(([k]) => k.startsWith('progress:')).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.updatedAt - a.updatedAt);
  const list = $('library');
  list.textContent = '';
  $('empty').hidden = items.length > 0;
  for (const item of items.slice(0, 200)) {
    const pct = item.done ? 100 : Math.min(99, Math.round(((item.wordsDone || 0) / Math.max(1, item.wordsTotal || 1)) * 100));
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = item.title || item.url;
    const local = /pdf-reader\.html$/.test(item.url);
    a.href = local ? 'pdf-reader.html' : item.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${describe(item.url)} · ${item.done ? 'Finished' : `${pct}%`} · ${ago(item.updatedAt)}`;
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.onclick = async () => {
      await chrome.storage.local.remove(item.key);
      const doc = new URL(item.url).searchParams.get('doc');
      if (doc) await deleteDoc(doc).catch(() => {});
      renderLibrary();
    };
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${pct}%`;
    track.append(fill);
    li.append(a, remove, meta, track);
    list.append(li);
  }
}
renderLibrary();
