// ElevenLabs as a second voice provider. Voice ids are "eleven:<voice_id>", so the rest of the
// server can route by prefix. Audio comes from the with-timestamps endpoint, whose per-character
// times become the same word boundaries the Edge path returns (100 ns ticks), so highlighting,
// captions and exports work unchanged. The API key lives on the server only.
import { HttpError } from './extract.js';

export const PREFIX = 'eleven:';
export const ID_RE = /^eleven:[A-Za-z0-9_-]{8,64}$/;
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
export const MAX_CHARS = 5000; // per request; the tester splits long text into paragraphs anyway
const API = 'https://api.elevenlabs.io';
const OUTPUT_FORMAT = 'mp3_44100_128';

export const isElevenVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
// An alignment entry that is only whitespace separates words. The class is spelled out (not \s / isspace())
// so the Worker and the Python server split identically.
const WHITESPACE_ENTRY = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/;
const ticks = (seconds) => Math.floor(seconds * 1e7 + 0.5); // half-up on both servers (Python's round() is half-even)
const codePoints = (s) => Array.from(s).length;

const title = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

/** fetch that turns network failures and timeouts into HttpErrors instead of a bare throw (which would be a 500). */
async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new HttpError(504, 'ElevenLabs timed out');
    throw new HttpError(502, `ElevenLabs error: ${e?.message || e}`);
  }
}

async function readJson(res) {
  try {
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(502, 'ElevenLabs returned an unreadable response');
  }
}

/** Error text for a failed ElevenLabs response, in plain words. */
async function fail(res) {
  let detail = null;
  try { detail = (await res.json())?.detail; } catch {}
  const status = typeof detail === 'object' && detail ? detail.status : undefined;
  const message = typeof detail === 'object' && detail ? detail.message : typeof detail === 'string' ? detail : '';
  if (res.status === 401 && status !== 'quota_exceeded') throw new HttpError(502, `ElevenLabs rejected the API key${message ? ` (${message})` : ''}: check ELEVENLABS_API_KEY on the server`);
  if (status === 'quota_exceeded' || res.status === 402) throw new HttpError(429, 'ElevenLabs credits for this month are used up. Edge voices still work; credits reset monthly');
  if (status === 'max_character_limit_exceeded') throw new HttpError(422, `Text is too long for ElevenLabs in one request (limit about ${MAX_CHARS} characters)`);
  if (res.status === 429) throw new HttpError(429, 'ElevenLabs is rate-limiting requests; try again in a moment');
  throw new HttpError(502, `ElevenLabs error: HTTP ${res.status}${message ? ` (${message})` : ''}`);
}

/**
 * The account's voices, in the shape /voices returns for Edge voices.
 * Listing costs no credits.
 */
export async function listVoices(key, { fetchImpl = globalThis.fetch } = {}) {
  const out = [];
  let token = null;
  for (let page = 0; page < 10; page++) {
    const url = `${API}/v2/voices?page_size=100${token ? `&next_page_token=${encodeURIComponent(token)}` : ''}`;
    const res = await request(fetchImpl, url, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) await fail(res);
    const data = await readJson(res);
    for (const v of Array.isArray(data.voices) ? data.voices : []) {
      const labels = v.labels || {};
      out.push({
        name: v.name || v.voice_id,
        shortName: `${PREFIX}${v.voice_id}`,
        locale: labels.language || '',
        localeName: [labels.accent, labels.age, labels.use_case].filter(Boolean).map(title).join(' · '),
        gender: title(labels.gender || ''),
        styleList: [],
        provider: 'elevenlabs',
        category: v.category || '',
        previewUrl: v.preview_url || '',
        sampleUrl: `/samples/${PREFIX}${v.voice_id}`,
      });
    }
    if (!data.has_more || !data.next_page_token) break;
    token = data.next_page_token;
  }
  return out;
}

/** Per-character times → word boundaries in 100 ns ticks, one per whitespace-separated word. */
export function alignmentToBoundaries(alignment) {
  const chars = alignment?.characters || [];
  const starts = alignment?.character_start_times_seconds || [];
  const ends = alignment?.character_end_times_seconds || [];
  const out = [];
  let i = 0;
  const isSpace = (c) => WHITESPACE_ENTRY.test(String(c));
  while (i < chars.length) {
    while (i < chars.length && isSpace(chars[i])) i++;
    if (i >= chars.length) break;
    const first = i;
    let text = '';
    while (i < chars.length && !isSpace(chars[i])) text += chars[i++];
    const offset = ticks(starts[first] || 0);
    const end = ticks(ends[i - 1] ?? starts[first] ?? 0);
    out.push({ offset, duration: Math.max(0, end - offset), text });
  }
  return out;
}

const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Synthesize with ElevenLabs.
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, { key, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!key) throw new HttpError(503, 'ElevenLabs voices are not configured on this server (no ELEVENLABS_API_KEY)');
  if (codePoints(text) > MAX_CHARS) throw new HttpError(422, `Text is limited to ${MAX_CHARS} characters per request for ElevenLabs voices`);
  const voiceId = voice.slice(PREFIX.length);
  const res = await request(fetchImpl, `${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ text, model_id: model }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) await fail(res);
  const data = await readJson(res);
  if (typeof data.audio_base64 !== 'string' || !data.audio_base64) throw new HttpError(502, 'ElevenLabs returned no audio');
  let audio;
  try { audio = base64ToBytes(data.audio_base64); } catch { throw new HttpError(502, 'ElevenLabs returned unreadable audio'); }
  return { audio, boundaries: alignmentToBoundaries(data.alignment || data.normalized_alignment) };
}

/**
 * This month's credit use, for /usage. Listing it costs nothing. The free plan counts characters,
 * so "credits" and "characters" are the same number here.
 */
export async function usage(key, { fetchImpl = globalThis.fetch } = {}) {
  const res = await request(fetchImpl, `${API}/v1/user/subscription`, { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) await fail(res);
  const s = await readJson(res);
  // Whole numbers, never a throw, the same way the Python server coerces them
  const num = (v) => Math.trunc(Number(v)) || 0;
  const used = num(s.character_count);
  const limit = num(s.character_limit);
  const reset = num(s.next_character_count_reset_unix);
  return {
    provider: 'elevenlabs',
    tier: typeof s.tier === 'string' ? s.tier : '',
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt: reset > 0 ? new Date(reset * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null,
  };
}

/** The voice's preview clip, for /samples/eleven:<id>. */
export async function sample(key, voice, { fetchImpl = globalThis.fetch } = {}) {
  const voices = await listVoices(key, { fetchImpl });
  const found = voices.find((v) => v.shortName === voice);
  if (!found) throw new HttpError(404, 'No such ElevenLabs voice on this account');
  if (!found.previewUrl) throw new HttpError(404, 'This ElevenLabs voice has no preview clip');
  if (!/^https:\/\//i.test(found.previewUrl)) throw new HttpError(502, 'ElevenLabs preview URL is not https');
  const res = await request(fetchImpl, found.previewUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new HttpError(502, `ElevenLabs preview failed: HTTP ${res.status}`);
  // The preview CDN labels the clips text/plain; a browser's audio element needs an audio type to play them
  const ct = res.headers.get('content-type') || '';
  return { audio: new Uint8Array(await res.arrayBuffer()), contentType: /^audio\//i.test(ct) ? ct : 'audio/mpeg' };
}
