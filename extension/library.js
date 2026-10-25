// Library: everything read in page mode, with progress. Data lives in
// chrome.storage.local under "progress:<url>" (written by content.js).
const MAX_ITEMS = 200;
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const clearBtn = document.getElementById('clear');

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const units = [[86400 * 365, 'year'], [86400 * 30, 'month'], [86400 * 7, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [secs, name] of units) {
    const n = Math.floor(s / secs);
    if (n >= 1) return `${n} ${name}${n > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}

async function render() {
  const all = await chrome.storage.local.get(null);
  const items = Object.entries(all).filter(([k]) => k.startsWith('progress:')).map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  // Keep storage bounded: drop the oldest beyond the cap
  const extra = items.splice(MAX_ITEMS);
  if (extra.length) await chrome.storage.local.remove(extra.map((i) => i.key));

  list.textContent = '';
  empty.hidden = items.length > 0;
  clearBtn.hidden = items.length === 0;
  for (const item of items) {
    const pct = item.done ? 100 : Math.min(99, Math.round(((item.wordsDone || 0) / Math.max(1, item.wordsTotal || 1)) * 100));
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'title';
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = item.title || item.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    let host = item.url;
    try {
      const u = new URL(item.url);
      const own = item.url.startsWith(chrome.runtime.getURL('')); // chrome-extension: or moz-extension:
      if (own && u.pathname.endsWith('/book.html')) {
        // Book chapters live on the extension's own pages; show where the book came from instead
        const link = u.searchParams.get('url');
        host = `Book · ${u.searchParams.has('id') ? 'archive.org' : link ? new URL(link).hostname.replace(/^www\./, '') : 'file on this computer'}`;
      } else if (own) {
        const inner = u.searchParams.get('url');
        host = inner ? `PDF · ${new URL(inner).hostname.replace(/^www\./, '') || 'file'}` : 'PDF (local file: choose it again to resume)';
      } else host = u.hostname.replace(/^www\./, '');
    } catch {}
    meta.textContent = `${host} · ${item.done ? 'Finished' : `${pct}% · paragraph ${(item.chunk || 0) + 1} of ${item.total || '?'}`} · ${ago(item.updatedAt)}`;
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Remove from library';
    remove.textContent = 'Remove';
    remove.onclick = async () => { await chrome.storage.local.remove(item.key); render(); };
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    li.append(a, remove, meta, track);
    list.appendChild(li);
  }
}

clearBtn.onclick = async () => {
  if (!confirm('Remove everything from your library?')) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('progress:')));
  render();
};
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('progress:'))) render(); });
render();
