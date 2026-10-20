// Books page: search archive.org, pick a book, then read it one chapter per page.
// Each chapter is an ordinary page, so the reader works on it like any article. Progress
// is keyed by the chapter URL, so each chapter keeps its own place in the library.
import { searchBooks, fetchBookInfo, downloadBook } from './lib/archive.js';
import { readEpub } from './lib/epub.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const bookId = params.get('id');
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
  return `book.html?id=${encodeURIComponent(bookId)}${extra}`;
}

// ---- Search ----
$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
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
async function loadBook() {
  const info = await fetchBookInfo(bookId);
  const book = await readEpub(await downloadBook(info.url));
  return { ...book, title: book.title || info.title, author: book.author || info.author };
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
    status(statusEl, err.message, true);
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
    for (const block of chapter.blocks) {
      // The chapter title was already shown above; don't repeat it
      if (block.tag === 'h' && block.text === chapter.title) continue;
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
    status(statusEl, err.message, true);
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
    const tab = await chrome.tabs.getCurrent();
    window.__danTtsTabId = tab.id;
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
    chrome.runtime.sendMessage({ target: 'background', cmd: 'read-tab' });
  } catch (err) {
    status($('chapter-status'), err.message, true);
  }
});

if (!bookId) show('search-view');
else if (chapterParam === null) showChapters();
else showChapter(Number(chapterParam));
