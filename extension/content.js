// dan-tts content script: extracts text, shows the reader UI, highlights words.
// Injected on demand (toolbar, context menu, shortcut); safe to inject twice.
(() => {
  if (window.__danTts) return;
  window.__danTts = true;

  const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const settings = { voice: 'en-US-AriaNeural', rate: 1 };
  const toPlayer = (cmd, data = {}) => chrome.runtime.sendMessage({ target: 'player', cmd, ...data });

  // ---- State ----
  let mode = null;          // 'page' (reader overlay) | 'selection' (in-place highlight)
  let tokens = [];          // [{ text, el? , range? }]
  let chunks = [];          // strings sent to the voice
  let chunkStart = [];      // token index where each chunk begins (exact for page, estimated for selection)
  let alignments = {};      // chunk -> { map, boundaries }
  let currentChunk = 0;
  let state = 'idle';
  let activeToken = -1;
  let userScrolledAt = 0;
  // Next page (chapter-per-page books, multi-page articles)
  let nextLink = null;      // { url, label } of the page being read, when it has a same-site "next" link
  let nextDoc = null;       // a page fetched by "Continue": pageParagraphs() returns it instead of the DOM
  let hops = 0;             // pages continued into without leaving the tab (history.pushState)
  let hop = 0;              // bumps when a hop starts and when the reader stops or restarts, so a slow fetch can't act after the user moved on
  let loadingNext = false;  // a hop's fetch is in flight: ignore more clicks until it settles
  let autoHere = false;     // this site is remembered: continue on its own when a page ends
  let countdown = null;

  // ---- UI (shadow DOM so pages can't restyle it and it can't break pages) ----
  const host = document.createElement('dan-tts-root');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      .overlay { position: fixed; inset: 0; z-index: 2147483646; overflow-y: auto; background: var(--bg); color: var(--fg); display: none; }
      .overlay.open { display: block; }
      .article { max-width: 720px; margin: 0 auto; padding: 48px 24px 160px; font-size: 21px; line-height: 1.7; }
      .article h1 { font-size: 32px; line-height: 1.25; margin: 0 0 8px; }
      .article .byline { color: var(--muted); font-size: 15px; margin-bottom: 28px; }
      .article p { margin: 0 0 1em; }
      .w { cursor: pointer; border-radius: 3px; }
      .w:hover { background: var(--hover); }
      .w.active { background: var(--hl); color: var(--hl-fg); }
      .bar { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 2147483647; display: flex; align-items: center; gap: 6px;
        background: var(--bar); color: var(--fg); border: 1px solid var(--border); border-radius: 999px; padding: 6px 10px; box-shadow: 0 8px 30px rgba(0,0,0,.25); font-size: 14px; }
      .bar.hidden { display: none; }
      button, select { font: inherit; color: inherit; background: transparent; border: 0; border-radius: 999px; padding: 6px 10px; cursor: pointer; }
      button:hover, select:hover { background: var(--hover); }
      button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); }
      .play { background: var(--accent); color: var(--accent-fg); min-width: 40px; }
      .play:hover { background: var(--accent); filter: brightness(1.1); }
      select { max-width: 170px; }
      .status { color: var(--muted); font-size: 12px; min-width: 56px; text-align: center; }
      .error { color: #e5484d; }
      .nextbox { margin-top: 48px; padding: 16px 18px; border: 1px solid var(--border); border-radius: 12px; background: var(--bar); font-size: 16px; line-height: 1.5; }
      .nextbox .nexttitle { font-weight: 600; }
      .nextbox .nextbtns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
      .nextbox button { border: 1px solid var(--border); padding: 8px 14px; }
      .nextbox button.go { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
      .nextbox button.go:hover { background: var(--accent); filter: brightness(1.1); }
      .nextbox .nextnote { color: var(--muted); font-size: 13px; margin-top: 8px; }
      .nextbox .nextnote:empty { display: none; }
      .nextbox .nextnote a { color: inherit; text-decoration: underline; cursor: pointer; }
      .host { --bg: #fbfaf7; --fg: #1d1d1f; --muted: #6b6b70; --bar: #ffffff; --border: #e3e1dc; --hover: rgba(0,0,0,.06);
        --hl: #fde68a; --hl-fg: inherit; --accent: #4f46e5; --accent-fg: #fff; }
      @media (prefers-color-scheme: dark) {
        .host { --bg: #17171a; --fg: #ececf0; --muted: #9a9aa3; --bar: #222227; --border: #34343b; --hover: rgba(255,255,255,.08);
          --hl: #854d0e; --hl-fg: #fff; --accent: #818cf8; --accent-fg: #0b0b10; }
      }
    </style>
    <div class="host">
      <div class="overlay" part="overlay"><div class="article"></div></div>
      <div class="bar hidden" role="toolbar" aria-label="dan-tts reader">
        <button class="prev" title="Previous paragraph (←)">⏮</button>
        <button class="play" title="Play/Pause (Space)">▶</button>
        <button class="next" title="Next paragraph (→)">⏭</button>
        <select class="speed" title="Speed"></select>
        <select class="voice" title="Voice"><option>${settings.voice}</option></select>
        <span class="status"></span>
        <button class="restart" title="Start from the beginning">⟲</button>
        <button class="close" title="Close (Esc)">✕</button>
      </div>
    </div>`;
  const $ = (s) => shadow.querySelector(s);
  const overlay = $('.overlay'), article = $('.article'), bar = $('.bar');
  const playBtn = $('.play'), speedSel = $('.speed'), voiceSel = $('.voice'), statusEl = $('.status');
  speedSel.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join('');
  document.documentElement.appendChild(host);

  // ---- Settings ----
  const ready = chrome.storage.sync.get(['voice', 'rate']).then((s) => {
    Object.assign(settings, Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)));
    speedSel.value = String(settings.rate);
    voiceSel.innerHTML = `<option value="${settings.voice}">${settings.voice}</option>`;
  });

  let voicesLoaded = false;
  async function loadVoices() {
    if (voicesLoaded) return;
    const res = await chrome.runtime.sendMessage({ target: 'background', cmd: 'voices' });
    if (!res?.voices) return;
    voicesLoaded = true;
    const lang = (navigator.language || 'en-US').split('-')[0];
    const byLocale = {};
    for (const v of res.voices) (byLocale[v.LocaleName || v.Locale] ??= []).push(v);
    const locales = Object.keys(byLocale).sort((a, b) => {
      const pa = byLocale[a][0].Locale.startsWith(lang) ? 0 : 1, pb = byLocale[b][0].Locale.startsWith(lang) ? 0 : 1;
      return pa - pb || a.localeCompare(b);
    });
    const label = (v) => `${v.ShortName.split('-').slice(2).join('-').replace(/Neural$/, '').replace(/Multilingual$/, ' (multilingual)')} · ${v.Gender[0]}`;
    voiceSel.innerHTML = locales.map((loc) => `<optgroup label="${loc}">${byLocale[loc].map((v) =>
      `<option value="${v.ShortName}">${label(v)}</option>`).join('')}</optgroup>`).join('');
    voiceSel.value = settings.voice;
  }

  // ---- Text extraction ----
  const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,dt,dd,td,th';

  function pageParagraphs() {
    if (nextDoc) return nextDoc;
    // The PDF reader page hands over paragraphs it already extracted
    if (window.__danTtsDoc) return window.__danTtsDoc;
    return docParagraphs(document, document.title, () => document.body.innerText);
  }

  // Readable paragraphs of a document: the live page, or one fetched by "Continue"
  function docParagraphs(doc, fallbackTitle, fallbackText) {
    let title = fallbackTitle, byline = '', blocks = [];
    try {
      const parsed = new Readability(doc.cloneNode(true)).parse();
      if (parsed?.content) {
        title = parsed.title || title;
        byline = parsed.byline || '';
        const content = new DOMParser().parseFromString(parsed.content, 'text/html');
        const els = [...content.body.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
        blocks = els.map((el) => ({ tag: /^H[1-6]$/.test(el.tagName) ? 'h' : 'p', text: el.textContent.replace(/\s+/g, ' ').trim() }));
      }
    } catch (e) { console.warn('dan-tts: Readability failed', e); }
    if (blocks.filter((b) => b.text).length === 0) {
      blocks = fallbackText().split(/\n\s*\n|\n/).map((t) => ({ tag: 'p', text: t.replace(/\s+/g, ' ').trim() }));
    }
    // "Article Title | Site Name" → "Article Title" (don't read the site name aloud)
    const parts = title.split(/\s+[|·•–—]\s+|\s+-\s+/);
    if (parts.length > 1 && parts[0].length >= 12) title = parts[0];
    // Readability sometimes keeps short calls-to-action next to the article; skip those
    const BOILERPLATE = /\b(subscribe|newsletter|sign up|sign in|log in|cookie|advertisement|share this|follow us)\b/i;
    blocks = blocks.filter((b) => b.text && !(b.text.length < 140 && BOILERPLATE.test(b.text)));
    return { title, byline, blocks };
  }

  // ---- Next page ----
  // A same-site "next" link (next chapter, next page of an article) is offered at the end of
  // the text. "Continue" fetches that page and reads it here, in this tab, moving the address
  // with history.pushState so each page keeps its own place in the library. "Always on this
  // site" does that by itself whenever a page ends. Closing the reader afterwards reloads the
  // tab, so the page under the overlay is the one the address bar shows.
  const siteHost = () => { try { return new URL(/^https?:/.test(window.__danTtsDocId || '') ? window.__danTtsDocId : location.href).hostname; } catch { return location.hostname; } };

  function findNext() {
    if (nextDoc) return nextDoc.next || null;
    if (window.__danTtsDoc) return window.__danTtsDoc.next || null; // the desktop reader finds it when it downloads the page
    return typeof danNextLink !== 'undefined' ? danNextLink.find(document, document.baseURI, location.href) : null;
  }

  async function setAutoNext(on) {
    autoHere = on;
    const { autoNext = {} } = await chrome.storage.sync.get('autoNext');
    if (on) autoNext[siteHost()] = true; else delete autoNext[siteHost()];
    await chrome.storage.sync.set({ autoNext });
  }

  function showNextBox(state = autoHere ? 'auto' : 'ask') {
    article.querySelector('.nextbox')?.remove();
    if (!nextLink || mode !== 'page') return;
    const box = document.createElement('div');
    box.className = 'nextbox';
    const label = document.createElement('div');
    const title = document.createElement('span');
    title.className = 'nexttitle';
    title.textContent = nextLink.label;
    label.append('Next: ', title);
    const btns = document.createElement('div');
    btns.className = 'nextbtns';
    const note = document.createElement('div');
    note.className = 'nextnote';
    const button = (cls, text, fn) => { const b = document.createElement('button'); b.className = cls; b.textContent = text; b.addEventListener('click', fn); btns.append(b); };
    const link = (text, fn) => { const a = document.createElement('a'); a.textContent = text; a.addEventListener('click', (e) => { e.preventDefault(); fn(); }); return a; };
    if (state === 'countdown') {
      button('go', 'Go now', () => goNext());
      button('stay', 'Stay here', () => { cancelCountdown(); setStatus('Done'); showNextBox('stayed'); });
    } else {
      button('go', 'Continue ▸', () => goNext());
      if (!autoHere) button('always', 'Always on this site', () => { setAutoNext(true).catch(() => {}); goNext(); });
    }
    if (autoHere) {
      const lead = state === 'stayed' ? 'Not continuing this time. ' : state === 'countdown' ? '' : 'Continues on its own when this page ends. ';
      if (lead) note.append(lead);
      note.append(link('Turn off for this site', () => {
        const counting = !!countdown;
        cancelCountdown();
        setAutoNext(false).catch(() => {});
        if (counting) setStatus('Done');
        showNextBox();
      }));
    }
    box.append(label, btns, note);
    article.append(box);
  }

  function pageEnded() {
    if (!nextLink) return;
    if (autoHere) { startCountdown(); return; }
    if (Date.now() - userScrolledAt > 3000) article.querySelector('.nextbox')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function startCountdown() {
    cancelCountdown();
    showNextBox('countdown');
    let n = 3;
    const tick = () => {
      if (n === 0) { countdown = null; goNext(); return; }
      setStatus(`Next page in ${n}…`);
      n--;
      countdown = setTimeout(tick, 1000);
    };
    tick();
  }
  function cancelCountdown() { clearTimeout(countdown); countdown = null; }

  // Like the browser would: the header's charset, else a <meta charset> near the top, else UTF-8
  // (Response.text() is always UTF-8, and chapter-per-page sites are often older and not)
  function decodeHtml(bytes, contentType) {
    let charset = (contentType.match(/charset=["']?([\w.:-]+)/i) || [])[1];
    if (!charset) charset = (new TextDecoder('latin1').decode(bytes.subarray(0, 2048)).match(/<meta[^>]+charset=["']?([\w.:-]+)/i) || [])[1];
    try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
  }

  async function fetchNextDoc(url) {
    const res = await fetch(url, { headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok || !/html|xml/i.test(res.headers.get('content-type') || '')) throw new Error(`HTTP ${res.status}`);
    const finalUrl = res.url || url;
    if (new URL(finalUrl).origin !== location.origin) throw new Error('redirected off the site');
    const doc = new DOMParser().parseFromString(decodeHtml(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type') || ''), 'text/html');
    const base = doc.createElement('base');
    base.href = finalUrl;
    doc.head.prepend(base);
    const next = typeof danNextLink !== 'undefined' ? danNextLink.find(doc, finalUrl, finalUrl) : null;
    const parsed = docParagraphs(doc, doc.title || nextLink.label, () => {
      doc.querySelectorAll('script,style,noscript,template').forEach((el) => el.remove());
      return doc.body.textContent;
    });
    if (!parsed.blocks.some((b) => b.text)) throw new Error('no readable text');
    return { ...parsed, url: finalUrl, next };
  }

  async function goNext() {
    if (!nextLink || loadingNext) return;
    cancelCountdown();
    const { url } = nextLink;
    // Desktop app: its reader page downloads any address and starts reading by itself
    if (window.__danTtsDoc?.next) { stop(false); location.href = `reader.html?url=${encodeURIComponent(url)}`; return; }
    const mine = ++hop;
    loadingNext = true;
    article.querySelectorAll('.nextbox button').forEach((b) => { b.disabled = true; });
    setStatus('Loading next…');
    let doc = null;
    try { doc = await fetchNextDoc(url); } catch (e) { console.warn('dan-tts: could not load the next page here, opening it instead', e); }
    loadingNext = false;
    if (mine !== hop || mode !== 'page') return; // closed, restarted or read something else meanwhile
    stop(false); // stops the voice and saves this page's spot under its own address, before the address changes
    if (doc) { try { history.pushState(null, '', doc.url); } catch { doc = null; } }
    if (!doc) {
      // Load the page for real; the background starts the reader again once it is up
      const from = location.href.replace(/#.*$/, '');
      await chrome.runtime.sendMessage({ target: 'background', cmd: 'continue', url, from }).catch(() => {});
      location.href = url;
      return;
    }
    hops++;
    nextDoc = doc;
    document.title = doc.title;
    start('page');
  }

  function buildPage() {
    const { title, byline, blocks } = pageParagraphs();
    article.textContent = '';
    tokens = [];
    const addWords = (parent, text) => {
      text.split(/\s+/).filter(Boolean).forEach((word, i) => {
        if (i) parent.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.className = 'w';
        span.textContent = word;
        span.dataset.i = tokens.length;
        tokens.push({ text: word, el: span });
        parent.appendChild(span);
      });
    };
    // A title that's just the opening words (pasted text) would be read twice: don't speak it
    const speakTitle = !window.__danTtsDoc?.hideTitle;
    if (speakTitle) {
      const h1 = document.createElement('h1');
      addWords(h1, title);
      article.appendChild(h1);
    }
    if (byline) { const b = document.createElement('div'); b.className = 'byline'; b.textContent = byline; article.appendChild(b); }
    for (const block of blocks) {
      const el = document.createElement(block.tag === 'h' ? 'h2' : 'p');
      addWords(el, block.text);
      article.appendChild(el);
    }
    return [...(speakTitle ? [title] : []), ...blocks.map((b) => b.text)].join('\n\n');
  }

  function buildSelection(sel) {
    const range = sel.getRangeAt(0);
    tokens = [];
    const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (range.intersectsNode(n) && n.parentElement && !n.parentElement.closest('script,style,noscript')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.data.length;
      const re = /\S+/g;
      re.lastIndex = start;
      for (let m; (m = re.exec(node.data)) && m.index < end;) {
        const r = document.createRange();
        r.setStart(node, m.index);
        r.setEnd(node, Math.min(m.index + m[0].length, end));
        tokens.push({ text: r.toString(), range: r });
      }
    }
    const text = sel.toString();
    sel.removeAllRanges(); // the native selection color would hide the word highlight
    return text;
  }

  // ---- Highlighting ----
  function highlight(j) {
    if (j === activeToken) return;
    if (mode === 'page') {
      tokens[activeToken]?.el.classList.remove('active');
      const el = tokens[j]?.el;
      if (el) {
        el.classList.add('active');
        if (Date.now() - userScrolledAt > 3000) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } else if (mode === 'selection' && typeof Highlight !== 'undefined') {
      const r = tokens[j]?.range;
      if (r) {
        CSS.highlights.set('dan-tts-word', new Highlight(r));
        const rect = r.getBoundingClientRect();
        if ((rect.top < 60 || rect.bottom > innerHeight - 100) && Date.now() - userScrolledAt > 3000) {
          scrollBy({ top: rect.top - innerHeight / 3, behavior: 'smooth' });
        }
      }
    }
    activeToken = j;
  }
  function clearHighlight() {
    tokens[activeToken]?.el?.classList.remove('active');
    if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('dan-tts-word');
    activeToken = -1;
  }
  overlay.addEventListener('wheel', () => { userScrolledAt = Date.now(); }, { passive: true });
  overlay.addEventListener('touchmove', () => { userScrolledAt = Date.now(); }, { passive: true });
  addEventListener('wheel', () => { if (mode === 'selection') userScrolledAt = Date.now(); }, { passive: true });

  // ---- Progress (resume + library), page mode only ----
  // The PDF reader sets __danTtsDocUrl/__danTtsDocId so each PDF gets its own entry
  const pageUrl = () => window.__danTtsDocUrl || location.origin + location.pathname + location.search;
  const progressKey = () => 'progress:' + (window.__danTtsDocId || pageUrl());
  let readingUrl = '', readingKey = ''; // fixed when reading starts: the address can move (Back after a hop) before the last save
  let fingerprint = '';
  let lastSave = 0;
  let resumedNote = false;
  let keepAlive = null;
  let lastPos = null; // latest { chunk, ticks, wordsDone }, saved for real every ~2 s and on close
  const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  function saveProgress(fields) {
    if (mode !== 'page' || !readingKey) return;
    const title = window.__danTtsDoc?.title || article.querySelector('h1')?.textContent || document.title;
    chrome.storage.local.set({ [readingKey]: { url: readingUrl, title, fp: fingerprint, total: chunks.length, wordsTotal: tokens.length, updatedAt: Date.now(), ...fields } }).catch(() => {});
  }

  // ---- Start / controls ----
  async function start(requested) {
    await ready;
    hop++; // a hop still loading belongs to what was being read before
    stop(false);
    const sel = getSelection();
    const hasSelection = sel && !sel.isCollapsed && sel.toString().trim().length > 0;
    mode = requested === 'page' || (requested === 'auto' && !hasSelection) ? 'page' : 'selection';
    if (mode === 'selection' && !hasSelection) mode = 'page';

    const text = mode === 'page' ? buildPage() : buildSelection(sel);
    nextLink = mode === 'page' ? findNext() : null;
    autoHere = false;
    if (nextLink) {
      const { autoNext } = await chrome.storage.sync.get('autoNext');
      autoHere = !!autoNext?.[siteHost()];
    }
    showNextBox();
    chunks = chunkText(text);
    chunkStart = [];
    let n = 0;
    for (const c of chunks) { chunkStart.push(n); n += c.split(/\s+/).filter(Boolean).length; }
    alignments = {};
    currentChunk = 0;
    if (mode === 'page') { overlay.classList.add('open'); overlay.scrollTop = 0; document.documentElement.style.overflow = 'hidden'; }
    bar.classList.remove('hidden');
    setStatus('Loading…');
    if (!chunks.length) { setStatus('Nothing to read', true); return; }
    // Resume where this page was left off, if its text hasn't changed
    let startChunk = 0, startTicks = 0;
    resumedNote = false;
    if (mode === 'page') {
      fingerprint = `${chunks.length}:${hash(chunks.slice(0, 3).join('|').slice(0, 4000))}`;
      readingUrl = pageUrl();
      readingKey = progressKey();
      const saved = (await chrome.storage.local.get(readingKey))[readingKey];
      if (saved && saved.fp === fingerprint && !saved.done && (saved.chunk > 0 || saved.ticks > 2e7) && saved.chunk < chunks.length) {
        startChunk = saved.chunk;
        startTicks = Math.max(0, saved.ticks - 1e7); // back up a second for context
        resumedNote = true;
      }
      saveProgress({ chunk: startChunk, ticks: startTicks, wordsDone: chunkStart[startChunk] || 0, done: false });
    }
    toPlayer('load', { chunks, voice: settings.voice, rate: settings.rate, startChunk, startTicks });
    // Keep the background alive while reading (Firefox plays audio there and suspends it after ~30 s idle)
    clearInterval(keepAlive);
    keepAlive = setInterval(() => chrome.runtime.sendMessage({ target: 'background', cmd: 'keepalive' }).catch(() => {}), 10000);
    loadVoices().catch(() => {});
  }

  function stop(hide = true) {
    clearInterval(keepAlive);
    cancelCountdown();
    if (hide) hop++; // abandon a hop still loading
    if (mode === 'page' && lastPos && state !== 'idle') saveProgress(lastPos); // exact spot on close
    lastPos = null;
    if (mode) toPlayer('stop');
    clearHighlight();
    state = 'idle';
    playBtn.textContent = '▶';
    if (hide) {
      overlay.classList.remove('open');
      bar.classList.add('hidden');
      document.documentElement.style.overflow = '';
      mode = null;
      // After continuing to other pages, show the page the address bar now names
      if (hops) { hops = 0; location.reload(); }
    }
  }

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
  }

  function seekToken(j) {
    let c = chunkStart.length - 1;
    while (c > 0 && chunkStart[c] > j) c--;
    const a = alignments[c];
    const k = a ? a.map.findIndex((t) => t >= j) : -1;
    toPlayer('seek', { chunk: c, ticks: k > 0 ? a.boundaries[k].offset : 0 });
  }

  playBtn.addEventListener('click', () => {
    if (state === 'playing') toPlayer('pause');
    else if (state === 'paused') toPlayer('resume');
    else toPlayer('seek', { chunk: state === 'idle' ? 0 : currentChunk, ticks: 0 }); // finished: start over
  });
  $('.prev').addEventListener('click', () => toPlayer('seek', { chunk: Math.max(0, currentChunk - 1), ticks: 0 }));
  $('.next').addEventListener('click', () => { if (currentChunk + 1 < chunks.length) toPlayer('seek', { chunk: currentChunk + 1, ticks: 0 }); });
  $('.close').addEventListener('click', () => stop());
  $('.restart').addEventListener('click', () => { resumedNote = false; toPlayer('seek', { chunk: 0, ticks: 0 }); });
  speedSel.addEventListener('change', () => {
    settings.rate = Number(speedSel.value);
    chrome.storage.sync.set({ rate: settings.rate });
    toPlayer('rate', { rate: settings.rate });
  });
  voiceSel.addEventListener('focus', () => loadVoices().catch(() => {}));
  voiceSel.addEventListener('change', () => {
    settings.voice = voiceSel.value;
    chrome.storage.sync.set({ voice: settings.voice });
    alignments = {};
    toPlayer('voice', { voice: settings.voice });
  });
  article.addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) seekToken(Number(w.dataset.i));
  });
  addEventListener('keydown', (e) => {
    if (!mode || e.target.closest?.('input,textarea,[contenteditable="true"]')) return;
    if (e.key === 'Escape') { stop(); e.preventDefault(); }
    else if (mode === 'page' && e.key === ' ') { playBtn.click(); e.preventDefault(); }
    else if (mode === 'page' && e.key === 'ArrowRight') { $('.next').click(); e.preventDefault(); }
    else if (mode === 'page' && e.key === 'ArrowLeft') { $('.prev').click(); e.preventDefault(); }
  }, true);

  // Back/forward after continuing: close, which reloads the page the address bar now names
  addEventListener('popstate', () => { if (hops) stop(); });

  // After "Continue" had to load a page for real, that page may still be fetching its text
  // (which is usually why it couldn't be read from its HTML): give it up to 5 s to appear
  const textSettled = () => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { if ((document.body?.innerText || '').trim().length > 200 || Date.now() - t0 > 5000) resolve(); else setTimeout(tick, 250); };
    tick();
  });

  window.__danTtsStart = start; // used by the PDF reader page

  // ---- Messages from the player (via the background worker) ----
  chrome.runtime.onMessage.addListener((msg) => {
    // Book chapter pages hear every runtime message, so they take only those tagged with their
    // tab id. Other extension pages (the PDF reader) hear them too, and ignore any tagged one.
    if (msg.tabId !== window.__danTtsTabId) return;
    if (msg.event === 'start') { (msg.continued ? textSettled() : Promise.resolve()).then(() => start(msg.mode)); return; }
    if (!mode) return;
    if (msg.event === 'chunk') {
      currentChunk = msg.chunk;
      // Page tokens come from the chunk text itself, so chunkStart is exact. Selection tokens come
      // from the DOM and can split differently, so continue from where the last chunk ended.
      const prev = alignments[msg.chunk - 1];
      const startAt = mode === 'selection' && prev ? prev.next : chunkStart[msg.chunk];
      alignments[msg.chunk] = { ...danAlign.alignBoundaries(msg.boundaries, tokens, startAt), boundaries: msg.boundaries };
    } else if (msg.event === 'word') {
      const a = alignments[msg.chunk];
      const j = a && msg.word >= 0 ? a.map[msg.word] : -1;
      if (j >= 0) highlight(j);
      if (a && msg.word >= 0) {
        lastPos = { chunk: msg.chunk, ticks: a.boundaries[msg.word].offset, wordsDone: j >= 0 ? j : chunkStart[msg.chunk], done: false };
        if (Date.now() - lastSave > 2000) { lastSave = Date.now(); saveProgress(lastPos); }
      }
    } else if (msg.event === 'state') {
      if (countdown && msg.state !== 'paused') { cancelCountdown(); showNextBox(); } // playing again (⟲, a click): don't leave mid-page
      if (msg.state === 'loading' && msg.chunk !== currentChunk) clearHighlight(); // don't leave the old word lit
      state = msg.state;
      currentChunk = msg.chunk;
      playBtn.textContent = state === 'playing' ? '❚❚' : '▶';
      setStatus(state === 'loading' ? 'Loading…' : `${resumedNote && state === 'playing' ? 'Resumed · ' : ''}${msg.chunk + 1} / ${msg.total}`);
      if (state === 'playing' && resumedNote) setTimeout(() => { resumedNote = false; }, 4000);
    } else if (msg.event === 'ended') {
      lastPos = null;
      clearInterval(keepAlive);
      saveProgress({ chunk: 0, ticks: 0, wordsDone: tokens.length, done: true });
      state = 'idle';
      playBtn.textContent = '▶';
      setStatus('Done');
      clearHighlight();
      pageEnded();
    } else if (msg.event === 'error') {
      setStatus('Error', true);
      statusEl.title = msg.message;
      console.warn('dan-tts:', msg.message);
    }
  });
})();
