// Finds plain EPUB files on archive.org (public, no account). Only the public search and
// metadata APIs are used; the extension's host permission lets it call them directly.

const SEARCH = 'https://archive.org/advancedsearch.php';
const METADATA = 'https://archive.org/metadata/';

// Lending-library items are only viewable on archive.org, and their files download as 401
const isRestricted = (meta) => String(meta?.['access-restricted-item'] ?? '') === 'true';

// Returns [{ id, title, author }], most downloaded first
export async function searchBooks(query, rows = 20) {
  const terms = query.replace(/[():"\\]/g, ' ').trim();
  if (!terms) return [];
  const params = new URLSearchParams({ q: `(${terms}) AND mediatype:texts AND format:EPUB`, rows: String(rows), output: 'json', sort: 'downloads desc' });
  for (const field of ['identifier', 'title', 'creator', 'access-restricted-item']) params.append('fl[]', field);
  const res = await fetch(`${SEARCH}?${params}`);
  if (!res.ok) throw new Error(`archive.org search failed (${res.status})`);
  const { response } = await res.json();
  return response.docs.filter((d) => !isRestricted(d)).map((d) => ({ id: d.identifier, title: d.title || d.identifier, author: [d.creator].flat()[0] || '' }));
}

// Returns { url, title, author } for the item's plain EPUB, or throws if it has none
export async function fetchBookInfo(id) {
  const res = await fetch(`${METADATA}${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`archive.org item not found (${res.status})`);
  const item = await res.json();
  if (isRestricted(item.metadata)) throw new Error('This book is lending-library only on archive.org, so it can’t be read here');
  // Encrypted copies are labelled "ACS Encrypted EPUB" or "LCP Encrypted EPUB", so an exact match skips them
  const file = (item.files || []).find((f) => f.format === 'EPUB' && /\.epub$/i.test(f.name));
  if (!file) throw new Error('No readable EPUB in this archive.org item');
  const path = file.name.split('/').map(encodeURIComponent).join('/');
  return {
    url: `https://archive.org/download/${encodeURIComponent(id)}/${path}`,
    title: item.metadata?.title || id,
    author: [item.metadata?.creator].flat()[0] || '',
  };
}

export async function downloadBook(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.arrayBuffer();
}
