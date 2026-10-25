// Reads an EPUB into chapters of paragraphs. An EPUB is a ZIP of XHTML files, so this
// unpacks the ZIP with the browser's DecompressionStream and follows the package file's
// spine. Plain EPUBs only: DRM-protected files (Adobe ACS, Readium LCP) throw.

const SIG_EOCD = 0x06054b50; // end of central directory
const SIG_CENTRAL = 0x02014b50; // central directory file header
const SIG_LOCAL = 0x04034b50; // local file header
const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dt,dd,td,th';

async function inflate(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns { names, read(name) } where read() gives the file's bytes, or null if it isn't there.
export async function openZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  // The end record sits in the last 22 bytes unless the archive has a comment (up to 64 KiB)
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('Damaged ZIP directory');
    const nameLen = view.getUint16(p + 28, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, {
      method: view.getUint16(p + 10, true),
      size: view.getUint32(p + 20, true),
      local: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return {
    names: [...entries.keys()],
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (view.getUint32(e.local, true) !== SIG_LOCAL) throw new Error('Damaged ZIP entry');
      const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
      return inflate(bytes.subarray(start, start + e.size), e.method);
    },
  };
}

// Resolves href against dir (which ends in "/" or is ""), dropping any #fragment.
function resolvePath(dir, href) {
  const parts = (dir + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

function cleanText(el) {
  return el.textContent.replace(/\s+/g, ' ').trim();
}

// XHTML is strict XML; fall back to the HTML parser for the sloppy files that exist in the wild.
function parseChapter(text) {
  const parser = new DOMParser();
  let doc = parser.parseFromString(text, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) doc = parser.parseFromString(text, 'text/html');
  return doc;
}

function chapterBlocks(doc) {
  const body = doc.querySelector('body') || doc.documentElement;
  // Keep the innermost blocks, so nested <li><p> doesn't read twice
  const els = [...body.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
  return els
    .map((el) => ({ tag: /^H[1-6]$/i.test(el.tagName) ? 'h' : 'p', text: cleanText(el) }))
    .filter((b) => b.text);
}

// Table of contents titles keyed by file path: the EPUB 3 nav document, or the EPUB 2 NCX
async function readToc(opf, manifest, base, text) {
  const titles = new Map();
  const remember = (path, title) => { if (path && title && !titles.has(path)) titles.set(path, title); };
  const navItem = [...manifest.values()].find((item) => (item.getAttribute('properties') || '').split(' ').includes('nav'));
  const ncxItem = manifest.get(opf.getElementsByTagName('spine')[0]?.getAttribute('toc'));
  try {
    if (navItem) {
      const navPath = resolvePath(base, navItem.getAttribute('href'));
      const navDir = navPath.slice(0, navPath.lastIndexOf('/') + 1);
      const doc = parseChapter(await text(navPath));
      const toc = [...doc.getElementsByTagName('nav')].find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || doc;
      for (const a of toc.getElementsByTagName('a')) {
        if (a.getAttribute('href')) remember(resolvePath(navDir, a.getAttribute('href')), cleanText(a));
      }
    } else if (ncxItem) {
      const ncxPath = resolvePath(base, ncxItem.getAttribute('href'));
      const ncxDir = ncxPath.slice(0, ncxPath.lastIndexOf('/') + 1);
      const doc = new DOMParser().parseFromString(await text(ncxPath), 'application/xml');
      for (const point of doc.getElementsByTagName('*')) {
        if (point.localName !== 'navPoint') continue;
        const label = point.getElementsByTagName('text')[0];
        const src = point.getElementsByTagName('content')[0]?.getAttribute('src');
        if (label && src) remember(resolvePath(ncxDir, src), cleanText(label));
      }
    }
  } catch (e) {
    // A broken table of contents only costs us the nicer chapter names
    console.warn('dan-tts: could not read the table of contents', e);
  }
  return titles;
}

export async function readEpub(buffer) {
  const zip = await openZip(buffer);
  if (zip.names.includes('META-INF/rights.xml') || zip.names.includes('META-INF/license.lcpl')) {
    throw new Error('This book is DRM-protected and can’t be read here');
  }
  const text = async (name) => {
    const bytes = await zip.read(name);
    if (!bytes) throw new Error(`EPUB is missing ${name}`);
    return new TextDecoder().decode(bytes);
  };

  const container = new DOMParser().parseFromString(await text('META-INF/container.xml'), 'application/xml');
  const opfPath = container.getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB has no package file');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = new DOMParser().parseFromString(await text(opfPath), 'application/xml');

  const manifest = new Map();
  for (const item of opf.getElementsByTagName('item')) manifest.set(item.getAttribute('id'), item);

  const meta = (tag) => opf.getElementsByTagName(tag)[0]?.textContent.trim() || '';
  const title = meta('dc:title');
  const author = meta('dc:creator');
  const tocTitles = await readToc(opf, manifest, base, text);

  const chapters = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !/x?html/.test(item.getAttribute('media-type') || '')) continue;
    const path = resolvePath(base, item.getAttribute('href'));
    const bytes = await zip.read(path);
    if (!bytes) continue;
    const blocks = chapterBlocks(parseChapter(new TextDecoder().decode(bytes)));
    if (!blocks.length) continue;
    const heading = blocks.find((b) => b.tag === 'h');
    const chapterTitle = tocTitles.get(path) || (heading && heading.text) || `Section ${chapters.length + 1}`;
    chapters.push({ title: chapterTitle, blocks });
  }
  if (!chapters.length) throw new Error('No readable text found in this EPUB');
  return { title, author, chapters };
}
