// Books page: search archive.org, paste an EPUB link or open an EPUB file, then read it one
// chapter per page. Each chapter is an ordinary page, so the reader works on it like any
// article. Progress is keyed by the chapter URL, so each chapter keeps its own place in the
// library.
import { searchBooks, fetchBookInfo, downloadBook } from './lib/archive.js';
import { readEpub } from './lib/epub.js';
import { saveBookFile, getBookFile } from './lib/book-files.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Where the book comes from: an archive.org item (?id=), any EPUB address (?url=) or a file
// opened from this computer (?file=, see lib/book-files.js)
const source = ['id', 'url', 'file'].map((kind) => ({ kind, value: params.get(kind) })).find((s) => s.value);
const chapterParam = params.get('ch');

function show(view) {
  for (const id of ['search-view', 'toc-view', 'chapter-view']) $(id).hidden = id !== view;
}

function status(el, text, isError = false) {
  el.textContent = text;
  el.className = `status${isError ? ' error' : ''}`;
  el.hidden = !text;
}

function link(text, href) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  return a;
}

function bookUrl(extra = '') {
  return `book.html?${source.kind}=${encodeURIComponent(source.value)}${extra}`;
}

// A link pasted into the search box: an archive.org item page opens that item; any other
// address is downloaded as an EPUB. Without http(s):// only an .epub or archive.org address
// counts, so a search like "plato.republic" stays a search.
function linkTarget(text) {
  if (/\s/.test(text)) return null;
  const hasScheme = /^https?:\/\//i.test(text);
  if (!hasScheme && /^[a-z]+:/i.test(text)) return null; // ftp:, file: and the like
  let u;
  try { u = new URL(hasScheme ? text : `https://${text}`); } catch { return null; }
  const archive = /(^|\.)archive\.org$/.test(u.hostname);
  if (!hasScheme && !archive && !/\.epub$/i.test(u.pathname)) return null;
  const item = archive && u.pathname.match(/^\/details\/([^/]+)/);
  return item ? `book.html?id=${encodeURIComponent(decodeURIComponent(item[1]))}` : `book.html?url=${encodeURIComponent(u.href)}`;
}

// ---- A file from this computer ----
$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  status($('search-status'), 'Opening book…');
  try {
    const data = await file.arrayBuffer();
    await readEpub(data); // fail here, not on the next page, if it isn't a readable EPUB
    location.href = `book.html?file=${await saveBookFile(file.name, data)}`;
  } catch (err) {
    status($('search-status'), `Couldn't open that book: ${err.message}`, true);
  }
});

// ---- Search ----
$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = linkTarget($('q').value.trim());
  if (target) { location.href = target; return; }
  const results = $('results');
  results.textContent = '';
  status($('search-status'), 'Searching…');
  try {
    const books = await searchBooks($('q').value);
    status($('search-status'), books.length ? '' : 'No readable books found for that search.');
    for (const book of books) {
      const li = document.createElement('li');
      li.append(link(book.title, `book.html?id=${encodeURIComponent(book.id)}`));
      if (book.author) {
        const by = document.createElement('div');
        by.className = 'muted';
        by.textContent = book.author;
        li.append(by);
      }
      results.append(li);
    }
  } catch (err) {
    status($('search-status'), err.message, true);
  }
});

// ---- Loading a book (the EPUB is downloaded again each time a page opens) ----
class NeedsAccess extends Error {}

async function loadBook() {
  if (source.kind === 'id') {
    const info = await fetchBookInfo(source.value);
    const book = await readEpub(await downloadBook(info.url));
    return { ...book, title: book.title || info.title, author: book.author || info.author };
  }
  let name, data;
  if (source.kind === 'file') {
    const saved = await getBookFile(source.value);
    if (!saved) throw new Error('This book file is no longer saved here. Open it again from the Books page.');
    ({ name, data } = saved);
  } else {
    name = decodeURIComponent(new URL(source.value).pathname.split('/').pop() || 'Book');
    try {
      data = await downloadBook(source.value);
    } catch (err) {
      // A network error with no response: usually the extension lacks access to that site
      if (err instanceof TypeError && !window.danDesktop) throw new NeedsAccess(new URL(source.value).origin);
      throw err;
    }
  }
  const book = await readEpub(data);
  return { ...book, title: book.title || name.replace(/\.epub$/i, '') };
}

// Shows an error, or for a site the extension can't reach yet, a button to allow it
function loadFailed(statusEl, err) {
  if (!(err instanceof NeedsAccess)) { status(statusEl, err.message, true); return; }
  status(statusEl, `dan-tts needs permission to download books from ${new URL(err.message).hostname}. `, true);
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.textContent = 'Allow';
  allow.onclick = async () => { if (await chrome.permissions.request({ origins: [`${err.message}/*`] })) location.reload(); };
  statusEl.append(allow);
}

async function showChapters() {
  show('toc-view');
  const statusEl = $('toc-status');
  status(statusEl, 'Loading book…');
  try {
    const book = await loadBook();
    document.title = `${book.title} · dan-tts`;
    $('book-title').textContent = book.title;
    $('book-author').textContent = book.author;
    status(statusEl, '');
    const list = $('chapters');
    list.textContent = '';
    book.chapters.forEach((ch, i) => {
      const li = document.createElement('li');
      li.append(link(ch.title, bookUrl(`&ch=${i}`)));
      list.append(li);
    });
  } catch (err) {
    loadFailed(statusEl, err);
  }
}

async function showChapter(index) {
  show('chapter-view');
  const statusEl = $('chapter-status');
  status(statusEl, 'Loading chapter…');
  $('article').textContent = '';
  try {
    const book = await loadBook();
    const chapter = book.chapters[index];
    if (!chapter) throw new Error('This chapter doesn’t exist');
    document.title = `${chapter.title} — ${book.title}`;
    status(statusEl, '');

    const article = $('article');
    const heading = document.createElement('h2');
    heading.textContent = chapter.title;
    article.append(heading);
    // The chapter title was already shown above; don't repeat it
    const blocks = chapter.blocks.filter((block) => !(block.tag === 'h' && block.text === chapter.title));
    // The reader takes the chapter as-is instead of extracting it from the page, so links
    // like "← Chapters" aren't read aloud
    window.__danTtsDoc = { title: chapter.title, byline: book.title, blocks };
    for (const block of blocks) {
      const el = document.createElement(block.tag === 'h' ? 'h3' : 'p');
      el.textContent = block.text;
      article.append(el);
    }

    $('back-toc').href = bookUrl();
    const prev = $('prev'), next = $('next');
    prev.hidden = index === 0;
    prev.href = bookUrl(`&ch=${index - 1}`);
    next.hidden = index >= book.chapters.length - 1;
    next.href = bookUrl(`&ch=${index + 1}`);
  } catch (err) {
    loadFailed(statusEl, err);
  }
}

// The reader's scripts load only on chapter pages. content.js is the same reader that runs
// on web pages; here it gets its tab id so it accepts only this tab's messages.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(el);
  });
}

let readerReady = null;
function loadReader() {
  readerReady ??= (async () => {
    // The desktop app has no tabs: there is only this window
    const tab = await chrome.tabs?.getCurrent();
    if (tab) window.__danTtsTabId = tab.id;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'content.css';
    document.head.append(link);
    for (const src of ['lib/Readability.js', 'lib/chunk-text.js', 'lib/align.js', 'content.js']) await loadScript(src);
  })();
  return readerReady;
}

$('read').addEventListener('click', async () => {
  try {
    await loadReader();
    if (chrome.tabs) chrome.runtime.sendMessage({ target: 'background', cmd: 'read-tab' });
    else window.__danTtsStart('page');
  } catch (err) {
    status($('chapter-status'), err.message, true);
  }
});

if (!source) show('search-view');
else if (chapterParam === null) showChapters();
else showChapter(Number(chapterParam));
