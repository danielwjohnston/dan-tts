// Speechify as a voice provider. Voice ids are "speechify:<voice_id>", so the rest of the server
// can route by prefix. Timed speech comes from POST /v1/audio/speech, whose word-level speech marks
// (milliseconds) become the same word boundaries the Edge path returns (100 ns ticks); plain audio
// comes from POST /v1/audio/stream, which returns the bytes directly and takes ten times more text.
// The API key lives on the server only (SPEECHIFY_API_KEY) and is sent as a Bearer token.
import { HttpError } from './extract.js';

export const PREFIX = 'speechify:';
export const ID_RE = /^speechify:[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_MODEL = 'simba-3.5';
export const MAX_CHARS = 2000; // POST /v1/audio/speech: spoken characters per request (SSML tags are not counted)
export const MAX_STREAM_CHARS = 20000; // POST /v1/audio/stream
export const DEFAULT_API = 'https://api.speechify.ai'; // or a regional host: https://eu.api.speechify.ai, https://us.api.speechify.ai
const apiBase = (api) => String(api || DEFAULT_API).replace(/\/+$/, '');

export const isSpeechifyVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
const codePoints = (s) => Array.from(s).length;
const title = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const ticks = (ms) => Math.floor(num(ms) * 1e4 + 0.5); // milliseconds → 100 ns ticks, half-up like the Python server

// The markup tags lower() emits for Speechify. Text around them is escaped and the whole input wrapped
// in <speak> before sending, so "&" or "<" typed by a user never breaks the XML. Anything else that
// looks like a tag is spoken as written: hand-written SSML is not passed through, markup tokens are.
const OUR_TAGS = /(<break time="\d+ms"\s*\/>|<sub alias="[^"<>]*">[^<>]*<\/sub>)/;
export const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
/** The request's `input`: plain text as it is, or an SSML document when the text carries our tags. */
export function toInput(text) {
  if (!OUR_TAGS.test(text)) return text;
  return `<speak>${text.split(OUR_TAGS).map((part, i) => (i % 2 ? part : escapeXml(part))).join('')}</speak>`;
}

/** fetch that turns network failures and timeouts into HttpErrors instead of a bare throw (which would be a 500). */
async function request(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new HttpError(504, 'Speechify timed out');
    throw new HttpError(502, `Speechify error: ${e?.message || e}`);
  }
}

async function readJson(res) {
  try {
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(502, 'Speechify returned an unreadable response');
  }
}

/** Error text for a failed Speechify response, in plain words. Speechify says to match on error.code. */
async function fail(res) {
  let error = null;
  try { error = (await res.json())?.error; } catch {}
  const code = typeof error === 'object' && error ? String(error.code || '') : '';
  const message = typeof error === 'object' && error ? String(error.message || '') : '';
  const suffix = message ? ` (${message})` : '';
  if (res.status === 401) throw new HttpError(502, `Speechify rejected the API key${suffix}: check SPEECHIFY_API_KEY on the server`);
  if (res.status === 402) throw new HttpError(429, `Speechify credits for this workspace are used up or the plan does not allow this${suffix}. Edge voices still work`);
  if (code === 'model_retired') throw new HttpError(502, `Speechify retired the configured model${suffix}: set SPEECHIFY_MODEL to ${DEFAULT_MODEL} on the server`);
  if (code === 'content_policy_violation') throw new HttpError(422, `Speechify declined this text under its content policy${suffix}`);
  if (res.status === 400 || res.status === 422) throw new HttpError(422, `Speechify rejected the request${suffix}`);
  if (res.status === 404) throw new HttpError(404, `No such Speechify voice${suffix}`);
  if (res.status === 429) {
    const wait = res.headers?.get?.('retry-after');
    throw new HttpError(429, `Speechify is rate-limiting requests; try again in ${wait ? `${wait} seconds` : 'a moment'}`);
  }
  throw new HttpError(502, `Speechify error: HTTP ${res.status}${suffix}`);
}

const headers = (key, extra = {}) => ({ Authorization: `Bearer ${key}`, Accept: 'application/json', ...extra });

/** The body both synthesis endpoints take. `language` is sent only when the server configures one. */
function body(text, voice, { model, language }) {
  const out = { input: toInput(text), voice_id: voice.slice(PREFIX.length), model: model || DEFAULT_MODEL, audio_format: 'mp3' };
  if (language) out.language = language;
  return out;
}

function check(text, voice, key, limit) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!key) throw new HttpError(503, 'Speechify voices are not configured on this server (no SPEECHIFY_API_KEY)');
  if (codePoints(text) > limit) throw new HttpError(422, `Text is limited to ${limit} characters per request for Speechify voices`);
}

/**
 * The voices the workspace can use with the model, in the shape /voices returns for Edge voices.
 * Listing costs nothing.
 */
export async function listVoices(key, { model = DEFAULT_MODEL, api = DEFAULT_API, fetchImpl = globalThis.fetch } = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const url = `${apiBase(api)}/v1/voices?limit=200&model=${encodeURIComponent(model)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await request(fetchImpl, url, { headers: headers(key), signal: AbortSignal.timeout(20000) });
    if (!res.ok) await fail(res);
    const data = await readJson(res);
    for (const v of Array.isArray(data.voices) ? data.voices : []) {
      if (!v || typeof v.id !== 'string' || !v.id) continue;
      const languages = (Array.isArray(v.models) ? v.models : []).flatMap((m) => (Array.isArray(m?.languages) ? m.languages : []));
      const preview = v.preview_audio || languages.find((l) => l?.preview_audio)?.preview_audio || '';
      const tags = (Array.isArray(v.tags) ? v.tags : []).filter((t) => typeof t === 'string').slice(0, 3);
      out.push({
        name: v.display_name || v.id,
        shortName: `${PREFIX}${v.id}`,
        locale: v.locale || '',
        localeName: [v.locale, ...tags].filter(Boolean).join(' · '),
        gender: v.gender === 'not_specified' ? '' : title(v.gender || ''),
        styleList: [],
        provider: 'speechify',
        category: v.type || '',
        previewUrl: typeof preview === 'string' ? preview : '',
        sampleUrl: `/samples/${PREFIX}${v.id}`,
      });
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return out;
}

/**
 * Speech marks → word boundaries in 100 ns ticks. Speechify nests them (a sentence or the whole input
 * holds `chunks` of words, each with start_time/end_time in milliseconds and the spoken `value`); the
 * innermost entries are the words. A streaming response gives an array of such objects.
 */
export function marksToBoundaries(marks) {
  const out = [];
  const walk = (m) => {
    if (Array.isArray(m)) { m.forEach(walk); return; }
    if (!m || typeof m !== 'object') return;
    if (Array.isArray(m.chunks) && m.chunks.length) { m.chunks.forEach(walk); return; }
    const text = typeof m.value === 'string' ? m.value.trim() : '';
    if (!text) return;
    const offset = ticks(m.start_time);
    out.push({ offset, duration: Math.max(0, ticks(m.end_time) - offset), text });
  };
  walk(marks);
  return out;
}

const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Synthesize with word timings (POST /v1/audio/speech).
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, { key, model = DEFAULT_MODEL, language = '', api = DEFAULT_API, fetchImpl = globalThis.fetch } = {}) {
  check(text, voice, key, MAX_CHARS);
  const res = await request(fetchImpl, `${apiBase(api)}/v1/audio/speech`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body(text, voice, { model, language })),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) await fail(res);
  const data = await readJson(res);
  if (typeof data.audio_data !== 'string' || !data.audio_data) throw new HttpError(502, 'Speechify returned no audio');
  let audio;
  try { audio = base64ToBytes(data.audio_data); } catch { throw new HttpError(502, 'Speechify returned unreadable audio'); }
  return { audio, boundaries: marksToBoundaries(data.speech_marks) };
}

/** Plain audio, no timings (POST /v1/audio/stream): the bytes as Speechify generates them. */
export async function stream(text, voice, { key, model = DEFAULT_MODEL, language = '', api = DEFAULT_API, fetchImpl = globalThis.fetch } = {}) {
  check(text, voice, key, MAX_STREAM_CHARS);
  const res = await request(fetchImpl, `${apiBase(api)}/v1/audio/stream`, {
    method: 'POST',
    headers: headers(key, { 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
    body: JSON.stringify(body(text, voice, { model, language })),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) await fail(res);
  const audio = new Uint8Array(await res.arrayBuffer());
  if (!audio.length) throw new HttpError(502, 'Speechify returned no audio');
  return { audio };
}

/** The voice's preview clip, for /samples/speechify:<id>. A cloned voice without one has a sample download instead. */
export async function sample(key, voice, { model = DEFAULT_MODEL, api = DEFAULT_API, fetchImpl = globalThis.fetch } = {}) {
  const voices = await listVoices(key, { model, api, fetchImpl });
  const found = voices.find((v) => v.shortName === voice);
  if (!found) throw new HttpError(404, 'No such Speechify voice for this workspace and model');
  let res;
  if (found.previewUrl) {
    if (!/^https:\/\//i.test(found.previewUrl)) throw new HttpError(502, 'Speechify preview URL is not https');
    res = await request(fetchImpl, found.previewUrl, { signal: AbortSignal.timeout(20000) });
  } else if (found.category === 'personal') {
    res = await request(fetchImpl, `${apiBase(api)}/v1/voices/${encodeURIComponent(voice.slice(PREFIX.length))}/sample`, { headers: headers(key, { Accept: '*/*' }), signal: AbortSignal.timeout(20000) });
    if (!res.ok) await fail(res);
  } else {
    throw new HttpError(404, 'This Speechify voice has no preview clip');
  }
  if (!res.ok) throw new HttpError(502, `Speechify preview failed: HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  return { audio: new Uint8Array(await res.arrayBuffer()), contentType: /^audio\//i.test(ct) ? ct : 'audio/mpeg' };
}
