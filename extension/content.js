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
    // The PDF reader page hands over paragraphs it already extracted
    if (window.__danTtsDoc) return window.__danTtsDoc;
    let title = document.title, byline = '', blocks = [];
    try {
      const parsed = new Readability(document.cloneNode(true)).parse();
      if (parsed?.content) {
        title = parsed.title || title;
        byline = parsed.byline || '';
        const doc = new DOMParser().parseFromString(parsed.content, 'text/html');
        const els = [...doc.body.querySelectorAll(BLOCKS)].filter((el) => !el.querySelector(BLOCKS));
        blocks = els.map((el) => ({ tag: /^H[1-6]$/.test(el.tagName) ? 'h' : 'p', text: el.textContent.replace(/\s+/g, ' ').trim() }));
      }
    } catch (e) { console.warn('dan-tts: Readability failed', e); }
    if (blocks.filter((b) => b.text).length === 0) {
      blocks = document.body.innerText.split(/\n\s*\n|\n/).map((t) => ({ tag: 'p', text: t.replace(/\s+/g, ' ').trim() }));
    }
    // "Article Title | Site Name" → "Article Title" (don't read the site name aloud)
    const parts = title.split(/\s+[|·•–—]\s+|\s+-\s+/);
    if (parts.length > 1 && parts[0].length >= 12) title = parts[0];
    // Readability sometimes keeps short calls-to-action next to the article; skip those
    const BOILERPLATE = /\b(subscribe|newsletter|sign up|sign in|log in|cookie|advertisement|share this|follow us)\b/i;
    blocks = blocks.filter((b) => b.text && !(b.text.length < 140 && BOILERPLATE.test(b.text)));
    return { title, byline, blocks };
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
    const h1 = document.createElement('h1');
    addWords(h1, title);
    article.appendChild(h1);
    if (byline) { const b = document.createElement('div'); b.className = 'byline'; b.textContent = byline; article.appendChild(b); }
    for (const block of blocks) {
      const el = document.createElement(block.tag === 'h' ? 'h2' : 'p');
      addWords(el, block.text);
      article.appendChild(el);
    }
    return [title, ...blocks.map((b) => b.text)].join('\n\n');
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
  let fingerprint = '';
  let lastSave = 0;
  let resumedNote = false;
  let lastPos = null; // latest { chunk, ticks, wordsDone }, saved for real every ~2 s and on close
  const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  function saveProgress(fields) {
    if (mode !== 'page') return;
    const title = tokens.length ? article.querySelector('h1')?.textContent || document.title : document.title;
    chrome.storage.local.set({ [progressKey()]: { url: pageUrl(), title, fp: fingerprint, total: chunks.length, wordsTotal: tokens.length, updatedAt: Date.now(), ...fields } }).catch(() => {});
  }

  // ---- Start / controls ----
  async function start(requested) {
    await ready;
    stop(false);
    const sel = getSelection();
    const hasSelection = sel && !sel.isCollapsed && sel.toString().trim().length > 0;
    mode = requested === 'page' || (requested === 'auto' && !hasSelection) ? 'page' : 'selection';
    if (mode === 'selection' && !hasSelection) mode = 'page';

    const text = mode === 'page' ? buildPage() : buildSelection(sel);
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
      const key = progressKey();
      const saved = (await chrome.storage.local.get(key))[key];
      if (saved && saved.fp === fingerprint && !saved.done && (saved.chunk > 0 || saved.ticks > 2e7) && saved.chunk < chunks.length) {
        startChunk = saved.chunk;
        startTicks = Math.max(0, saved.ticks - 1e7); // back up a second for context
        resumedNote = true;
      }
      saveProgress({ chunk: startChunk, ticks: startTicks, wordsDone: chunkStart[startChunk] || 0, done: false });
    }
    toPlayer('load', { chunks, voice: settings.voice, rate: settings.rate, startChunk, startTicks });
    loadVoices().catch(() => {});
  }

  function stop(hide = true) {
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

  window.__danTtsStart = start; // used by the PDF reader page

  // ---- Messages from the player (via the background worker) ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.event === 'start') { start(msg.mode); return; }
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
      if (msg.state === 'loading' && msg.chunk !== currentChunk) clearHighlight(); // don't leave the old word lit
      state = msg.state;
      currentChunk = msg.chunk;
      playBtn.textContent = state === 'playing' ? '❚❚' : '▶';
      setStatus(state === 'loading' ? 'Loading…' : `${resumedNote && state === 'playing' ? 'Resumed · ' : ''}${msg.chunk + 1} / ${msg.total}`);
      if (state === 'playing' && resumedNote) setTimeout(() => { resumedNote = false; }, 4000);
    } else if (msg.event === 'ended') {
      lastPos = null;
      saveProgress({ chunk: 0, ticks: 0, wordsDone: tokens.length, done: true });
      state = 'idle';
      playBtn.textContent = '▶';
      setStatus('Done');
      clearHighlight();
    } else if (msg.event === 'error') {
      setStatus('Error', true);
      statusEl.title = msg.message;
      console.warn('dan-tts:', msg.message);
    }
  });
})();
