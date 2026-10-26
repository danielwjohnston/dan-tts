// Player: synthesizes chunks with the engine and plays them, reporting progress to the
// tab. In Chrome it runs in an offscreen document (outside the page, so site CSP can't
// block audio). Firefox has no offscreen documents, so there the background page imports
// this module and drives it directly (handleCommand / setEventSink).
import { synthesize } from './engine/tts.js';
import { synthesizeServer, isServerVoice } from './engine/server.js';

const audio = document.getElementById('audio') || new Audio();
const openSocket = (url) => new WebSocket(url);

let session = 0;       // bumps on every load/stop so stale async work is ignored
let chunks = [];
let voice = 'en-US-AriaNeural';
let server;            // voice server setting from the reader (undefined = the default server)
let rate = 1;
let current = -1;
let cache = new Map(); // chunk index -> Promise<{ url, boundaries }>
let cacheGen = 0;      // bumps when the cache is cleared (new text or voice)
let boundaries = [];
let prefetched = -1;   // chunk whose successor a server-voice prefetch was already requested for
let lastWord = -1;
let ticker = null;

let emit = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});
const toTab = (event, data = {}) => emit({ target: 'tab', event, ...data });
/** Where player events go (default: runtime messages, relayed to the tab by the background). */
export function setEventSink(fn) { emit = fn; }

function synth(i) {
  if (!cache.has(i)) {
    const gen = cacheGen;
    // Provider voices ("eleven:…") come from the voice server; everything else is Edge, spoken directly
    const run = isServerVoice(voice) ? synthesizeServer(chunks[i], { voice, server }) : synthesize(chunks[i], { voice, openSocket });
    const p = run.then(({ audio: bytes, boundaries, contentType }) => {
      if (gen !== cacheGen) return null;
      return { url: URL.createObjectURL(new Blob([bytes], { type: contentType || 'audio/mpeg' })), boundaries };
    });
    p.catch(() => cache.delete(i)); // allow a retry
    cache.set(i, p);
  }
  return cache.get(i);
}

function clearCache() {
  for (const p of cache.values()) p.then((r) => r && URL.revokeObjectURL(r.url), () => {});
  cache = new Map();
  cacheGen++;
}

async function playChunk(i, startTicks = 0) {
  if (i < 0 || i >= chunks.length) { stopTicker(); toTab('ended'); return; }
  const mine = session;
  current = i;
  prefetched = -1;
  toTab('state', { state: 'loading', chunk: i, total: chunks.length });
  let r;
  try { r = await synth(i); } catch (e) {
    if (mine === session) audio.removeAttribute('src'); // so Play retries this chunk instead of replaying the last one
    toTab('error', { message: e.message });
    return;
  }
  if (mine !== session || !r) return;
  // Prefetch the next chunk. Server voices cost credits, so for those it waits until this chunk is
  // mostly played (see the ticker), rather than paying for a chunk the listener may never reach.
  if (i + 1 < chunks.length && !isServerVoice(voice)) synth(i + 1).catch(() => {});
  // Free audio we won't replay soon
  if (cache.has(i - 2)) { cache.get(i - 2).then((old) => old && URL.revokeObjectURL(old.url)); cache.delete(i - 2); }
  boundaries = r.boundaries;
  lastWord = -1;
  audio.src = r.url;
  audio.playbackRate = rate;
  toTab('chunk', { chunk: i, total: chunks.length, boundaries });
  await new Promise((res) => { if (audio.readyState >= 1) res(); else audio.onloadedmetadata = res; });
  if (mine !== session) return;
  audio.currentTime = startTicks / 1e7;
  try { await audio.play(); } catch (e) { toTab('error', { message: e.message }); return; }
  startTicker();
  toTab('state', { state: 'playing', chunk: i, total: chunks.length });
}

function startTicker() {
  stopTicker();
  ticker = setInterval(() => {
    const t = audio.currentTime * 1e7;
    let idx = -1;
    for (let k = 0; k < boundaries.length; k++) {
      if (boundaries[k].offset <= t) idx = k; else break;
    }
    if (idx !== lastWord) { lastWord = idx; toTab('word', { chunk: current, word: idx }); }
    if (isServerVoice(voice) && prefetched !== current && current + 1 < chunks.length && audio.duration && audio.currentTime > audio.duration * 0.7) {
      prefetched = current; // one attempt per chunk, even if it fails
      synth(current + 1).catch(() => {});
    }
  }, 40);
}
function stopTicker() { clearInterval(ticker); ticker = null; }

audio.addEventListener('ended', () => { stopTicker(); playChunk(current + 1); });

const commands = {
  load(msg) {
    session++;
    stopTicker();
    audio.pause();
    clearCache();
    chunks = msg.chunks;
    voice = msg.voice || voice;
    server = msg.server;
    rate = msg.rate || rate;
    playChunk(msg.startChunk || 0, msg.startTicks || 0);
  },
  pause() { audio.pause(); stopTicker(); toTab('state', { state: 'paused', chunk: current, total: chunks.length }); },
  resume() {
    if (current < 0) return;
    audio.play().then(() => { startTicker(); toTab('state', { state: 'playing', chunk: current, total: chunks.length }); });
  },
  seek(msg) {
    if (msg.chunk === current && audio.src) {
      audio.currentTime = (msg.ticks || 0) / 1e7;
      if (audio.paused) commands.resume();
    } else {
      session++;
      stopTicker();
      audio.pause();
      playChunk(msg.chunk, msg.ticks || 0);
    }
  },
  rate(msg) { rate = msg.rate; audio.playbackRate = rate; },
  voice(msg) {
    voice = msg.voice;
    if ('server' in msg) server = msg.server;
    const at = current;
    session++;
    clearCache();
    playChunk(at);
  },
  stop() { session++; stopTicker(); audio.pause(); audio.removeAttribute('src'); clearCache(); current = -1; chunks = []; },
};

export function handleCommand(msg) { commands[msg.cmd]?.(msg); }

// As an offscreen document, take commands from runtime messages
if (location.pathname.endsWith('/offscreen.html')) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.target !== 'offscreen') return false;
    handleCommand(msg);
    sendResponse({ ok: true });
    return false;
  });
}
