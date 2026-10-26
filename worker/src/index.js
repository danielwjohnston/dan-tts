// dan-tts API on Cloudflare Workers. Mirrors the Python server's endpoints so the
// tester (and anything else) can switch by changing the API base URL. Uses the shared
// engine to talk to Microsoft's voice service directly, and ElevenLabs when the
// ELEVENLABS_API_KEY secret is set (voices "eleven:<id>").
import { synthesize, connectionHeaders, listVoices } from '../../engine/src/tts.js';
import { extractText, HttpError } from './extract.js';
import * as eleven from './elevenlabs.js';

const MAX_TEXT_CHARS = 20000;
const VOICE_NAME_RE = /^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z]+Neural$/; // Edge voices; "eleven:<id>" is ElevenLabs
const validVoice = (voice) => VOICE_NAME_RE.test(voice) || eleven.ID_RE.test(voice);
const SAMPLE_TEXT = 'This is a sample of the selected voice.';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { ...CORS, ...headers } });

// Workers' outbound WebSocket: fetch() with Upgrade, then accept(). Wrapped in the
// small browser-style interface the engine expects.
async function openSocket(url) {
  const resp = await fetch(url.replace('wss://', 'https://'), { headers: { Upgrade: 'websocket', ...connectionHeaders() } });
  const ws = resp.webSocket;
  if (!ws) throw new HttpError(502, `Voice service refused the connection (HTTP ${resp.status})`);
  ws.binaryType = 'arraybuffer'; // the default here is Blob
  ws.accept();
  const sock = { readyState: 1, binaryType: 'arraybuffer', send: (d) => ws.send(d), close: () => ws.close() };
  ws.addEventListener('message', (e) => sock.onmessage?.(e));
  ws.addEventListener('close', (e) => sock.onclose?.(e));
  ws.addEventListener('error', (e) => sock.onerror?.(e));
  return sock;
}

const base64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function readRequest(request) {
  let body;
  try { body = await request.json(); } catch { throw new HttpError(400, 'Body must be JSON: {"text": "...", "voice": "...", "format": "mp3"}'); }
  const text = typeof body.text === 'string' ? body.text : '';
  const voice = body.voice || 'en-US-AriaNeural';
  const format = body.format || 'mp3';
  if (!text.trim()) throw new HttpError(400, 'Text is required');
  if (text.length > MAX_TEXT_CHARS) throw new HttpError(422, `Text is limited to ${MAX_TEXT_CHARS} characters per request`);
  if (!validVoice(voice)) throw new HttpError(400, 'Invalid voice name');
  if (format !== 'mp3') throw new HttpError(400, 'The Cloudflare Worker returns MP3 only (no ffmpeg here). Use format "mp3", or the Python server for m4a/ogg/flac.');
  return { text, voice, format };
}

// Route by provider: ElevenLabs ids carry a prefix, everything else is an Edge voice
const tts = (text, voice, env) => eleven.isElevenVoice(voice)
  ? eleven.synthesize(text, voice, { key: env.ELEVENLABS_API_KEY, model: env.ELEVENLABS_MODEL || eleven.DEFAULT_MODEL })
  : synthesize(text, { voice, openSocket }).catch((e) => { throw e instanceof HttpError ? e : new HttpError(502, `Voice service error: ${e.message}`); });
const providers = (env) => ['edge', ...(env.ELEVENLABS_API_KEY ? ['elevenlabs'] : [])];

// ---- Captions (same format as the Python server) ----
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (ms, sep) => `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
const span = (b) => [Math.floor(b.offset / 10000), Math.floor((b.offset + b.duration) / 10000)];

async function cached(request, ctx, ttlSeconds, make) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.ok && res.headers.get('Cache-Control') !== 'no-store') {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    ctx.waitUntil(cache.put(key, copy));
  }
  return res;
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'GET' && (path === '/health' || path === '/')) return json({ status: 'ok', runtime: 'cloudflare-worker', providers: providers(env) });

  if (request.method === 'GET' && path === '/voices') {
    return cached(request, ctx, 86400, async () => {
      const voices = (await listVoices({ headers: connectionHeaders() }))
        .filter((v) => v.Locale === 'en-US')
        .map((v) => ({ name: v.Name, shortName: v.ShortName, locale: v.Locale, localeName: v.LocaleName, gender: v.Gender, styleList: v.StyleList || [], provider: 'edge', sampleUrl: `/samples/${v.ShortName}` }));
      if (env.ELEVENLABS_API_KEY) {
        // A failed ElevenLabs listing (bad key, outage) must not hide the Edge voices
        try { voices.push(...await eleven.listVoices(env.ELEVENLABS_API_KEY)); }
        catch (e) { console.error(`ElevenLabs voice list unavailable: ${e.message}`); return json(voices, 200, { 'Cache-Control': 'no-store' }); }
      }
      return json(voices);
    });
  }

  const sample = path.match(/^\/samples\/([^/]+)$/);
  if (request.method === 'GET' && sample) {
    const voice = decodeURIComponent(sample[1]);
    if (!validVoice(voice)) throw new HttpError(400, 'Invalid voice name');
    if (eleven.isElevenVoice(voice) && !env.ELEVENLABS_API_KEY) throw new HttpError(503, 'ElevenLabs voices are not configured on this server (no ELEVENLABS_API_KEY)');
    return cached(request, ctx, 7 * 86400, async () => {
      if (eleven.isElevenVoice(voice)) {
        const { audio, contentType } = await eleven.sample(env.ELEVENLABS_API_KEY, voice);
        return new Response(audio, { headers: { ...CORS, 'Content-Type': contentType } });
      }
      const { audio } = await tts(SAMPLE_TEXT, voice, env);
      return new Response(audio, { headers: { ...CORS, 'Content-Type': 'audio/mpeg' } });
    });
  }

  if (request.method === 'POST' && path === '/synthesize') {
    const { text, voice } = await readRequest(request);
    const { audio } = await tts(text, voice, env);
    return new Response(audio, { headers: { ...CORS, 'Content-Type': 'audio/mpeg' } });
  }

  if (request.method === 'POST' && path === '/synthesize_with_timing') {
    const { text, voice, format } = await readRequest(request);
    const { audio, boundaries } = await tts(text, voice, env);
    return json({ audio: base64(audio), contentType: 'audio/mpeg', format, boundaries });
  }

  if (request.method === 'POST' && path === '/export') {
    const kind = url.searchParams.get('format') || 'json';
    if (!['json', 'webvtt', 'srt'].includes(kind)) throw new HttpError(400, "Format must be 'json', 'webvtt' or 'srt'");
    const { text, voice, format } = await readRequest(request);
    const { audio, boundaries } = await tts(text, voice, env);
    if (kind === 'json') {
      const last = boundaries[boundaries.length - 1];
      return json({ text, voice, format, audio: base64(audio), contentType: 'audio/mpeg', boundaries,
        metadata: { words: boundaries.length, duration_ms: last ? Math.floor((last.offset + last.duration) / 10000) : 0, generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') } });
    }
    const lines = kind === 'webvtt' ? ['WEBVTT', ''] : [];
    boundaries.forEach((b, i) => {
      const [s, e] = span(b);
      if (kind === 'srt') lines.push(String(i + 1));
      lines.push(`${stamp(s, kind === 'srt' ? ',' : '.')} --> ${stamp(e, kind === 'srt' ? ',' : '.')}`, b.text, '');
    });
    const ext = kind === 'srt' ? 'srt' : 'vtt';
    return new Response(lines.join('\n'), { headers: { ...CORS, 'Content-Type': kind === 'srt' ? 'application/x-subrip' : 'text/vtt', 'Content-Disposition': `attachment; filename="captions.${ext}"` } });
  }

  if (request.method === 'POST' && path === '/extract_text') {
    let body;
    try { body = await request.json(); } catch { throw new HttpError(400, 'Body must be JSON: {"url": "https://..."}'); }
    return json(await extractText(typeof body.url === 'string' ? body.url : ''));
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      return await route(request, env || {}, ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ detail: status === 500 ? 'Internal error' : err.message }, status);
    }
  },
};
