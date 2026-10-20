// Offscreen player: synthesizes chunks with the engine and plays them, reporting
// progress to the tab. Lives outside the page so site CSP can't block audio.
import { synthesize } from './engine/tts.js';

const audio = document.getElementById('audio');
const openSocket = (url) => new WebSocket(url);

let session = 0;       // bumps on every load/stop so stale async work is ignored
let chunks = [];
let voice = 'en-US-AriaNeural';
let rate = 1;
let current = -1;
let cache = new Map(); // chunk index -> Promise<{ url, boundaries }>
let cacheGen = 0;      // bumps when the cache is cleared (new text or voice)
let boundaries = [];
let lastWord = -1;
let ticker = null;

const toTab = (event, data = {}) => chrome.runtime.sendMessage({ target: 'tab', event, ...data }).catch(() => {});

function synth(i) {
  if (!cache.has(i)) {
    const gen = cacheGen;
    const p = synthesize(chunks[i], { voice, openSocket }).then(({ audio: bytes, boundaries }) => {
      if (gen !== cacheGen) return null;
      return { url: URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })), boundaries };
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
  toTab('state', { state: 'loading', chunk: i, total: chunks.length });
  let r;
  try { r = await synth(i); } catch (e) { toTab('error', { message: e.message }); return; }
  if (mine !== session || !r) return;
  if (i + 1 < chunks.length) synth(i + 1).catch(() => {}); // prefetch the next one
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
    const at = current;
    session++;
    clearCache();
    playChunk(at);
  },
  stop() { session++; stopTicker(); audio.pause(); audio.removeAttribute('src'); clearCache(); current = -1; chunks = []; },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  commands[msg.cmd]?.(msg);
  sendResponse({ ok: true });
  return false;
});
