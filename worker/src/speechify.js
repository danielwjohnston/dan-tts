// Speechify as a third voice provider. Voice ids are "speechify:<voice_id>", so the rest of the
// server can route by prefix. With word timings, audio comes from POST /v1/audio/speech (JSON:
// base64 audio plus speech marks, whose millisecond word times become the same 100 ns boundaries
// the Edge path returns, so highlighting, captions and exports work unchanged). Plain audio comes
// from POST /v1/audio/stream (the bytes themselves, and ten times the character allowance).
// The API key lives on the server only. Same rules as app/main.py.
import { HttpError } from './extract.js';

export const PREFIX = 'speechify:';
export const ID_RE = /^speechify:[A-Za-z0-9_-]{1,80}$/;
export const DEFAULT_MODEL = 'simba-3.5';
export const DEFAULT_LOCALE = 'en'; // voice list filter (prefix match); '' lists every locale
export const MAX_CHARS = 2000; // spoken characters per /v1/audio/speech request (the one with word timings)
export const STREAM_MAX_CHARS = 20000; // per /v1/audio/stream request (audio only)
export const USAGE_URL = 'https://platform.speechify.ai/usage';
const API = 'https://api.speechify.ai';

export const isSpeechifyVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
const codePoints = (s) => Array.from(s).length;
const title = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const isStr = (v) => typeof v === 'string';

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

/** Error text for a failed Speechify response ({"error": {"code", "message"}}), in plain words. */
async function fail(res, model) {
  let err = null;
  try { err = (await res.json())?.error; } catch {}
  const code = err && typeof err === 'object' && isStr(err.code) ? err.code : '';
  const message = err && typeof err === 'object' && isStr(err.message) ? err.message : '';
  const suffix = message ? ` (${message})` : '';
  if (res.status === 401) throw new HttpError(502, `Speechify rejected the API key${suffix}: check SPEECHIFY_API_KEY on the server`);
  if (res.status === 402) throw new HttpError(429, 'Speechify credits are used up or the spend limit is reached. Edge voices still work; see platform.speechify.ai');
  if (code === 'model_retired') throw new HttpError(502, `The Speechify model ${model} is retired: set SPEECHIFY_MODEL on the server to ${DEFAULT_MODEL}`);
  if (code === 'content_policy_violation') throw new HttpError(422, `Speechify refused this text under its content policy${suffix}`);
  if (res.status === 429) throw new HttpError(429, 'Speechify is rate-limiting requests; try again in a moment');
  if ([400, 404, 422].includes(res.status)) throw new HttpError(422, `Speechify rejected the request${suffix}`);
  throw new HttpError(502, `Speechify error: HTTP ${res.status}${suffix}`);
}

const headers = (key, accept) => ({ Authorization: `Bearer ${key}`, Accept: accept });

/** One /v1/voices entry in the shape /voices returns for Edge voices, or null when it cannot be used. */
function voiceEntry(v, model) {
  if (!v || typeof v !== 'object' || !isStr(v.id) || !ID_RE.test(`${PREFIX}${v.id}`)) return null;
  const models = Array.isArray(v.models) ? v.models : [];
  // the configured model cannot speak this voice: a request would be a 400
  if (models.length && !models.some((m) => m && m.name === model)) return null;
  const locale = isStr(v.locale) ? v.locale : '';
  const tags = Array.isArray(v.tags) ? v.tags.filter(isStr).slice(0, 3) : [];
  let preview = isStr(v.preview_audio) ? v.preview_audio : '';
  if (!preview) {
    for (const m of models) {
      const lang = (Array.isArray(m?.languages) ? m.languages : []).find((l) => l && isStr(l.preview_audio) && l.preview_audio && (!locale || l.locale === locale));
      if (lang) { preview = lang.preview_audio; break; }
    }
  }
  const gender = isStr(v.gender) && v.gender !== 'not_specified' ? title(v.gender) : '';
  return {
    name: isStr(v.display_name) && v.display_name ? v.display_name : v.id,
    shortName: `${PREFIX}${v.id}`,
    locale,
    localeName: [locale, ...tags.map(title)].filter(Boolean).join(' · '),
    gender,
    styleList: [],
    provider: 'speechify',
    category: isStr(v.type) ? v.type : '',
    previewUrl: preview,
    sampleUrl: `/samples/${PREFIX}${v.id}`,
  };
}

/**
 * The voices the model can speak (the workspace's own clones and the shared catalogue, filtered
 * to the locale), in the shape /voices returns for Edge voices. Listing costs nothing.
 */
export async function listVoices(key, { model = DEFAULT_MODEL, locale = DEFAULT_LOCALE, fetchImpl = globalThis.fetch } = {}) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const url = `${API}/v1/voices?limit=200${locale ? `&locale=${encodeURIComponent(locale)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await request(fetchImpl, url, { headers: headers(key, 'application/json'), signal: AbortSignal.timeout(20000) });
    if (!res.ok) await fail(res, model);
    const data = await readJson(res);
    for (const v of Array.isArray(data.voices) ? data.voices : []) {
      const entry = voiceEntry(v, model);
      if (entry) out.push(entry);
    }
    cursor = data.next_cursor;
    if (!data.has_more || !isStr(cursor) || !cursor) break;
  }
  return out;
}

/** Milliseconds (Speechify's unit) → 100 ns ticks, half-up like the Python server; anything odd is 0. */
const msTicks = (ms) => { const t = Math.floor(Number(ms) * 10000 + 0.5); return Number.isFinite(t) && t > 0 ? t : 0; };

/**
 * Speech marks → word boundaries in 100 ns ticks. The marks are a sentence with word chunks
 * (each: value, start_time, end_time in ms); the leaves of that tree, in order, are the words.
 */
export function speechMarksToBoundaries(marks) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.chunks) && node.chunks.length) { node.chunks.forEach(walk); return; }
    if (!isStr(node.value) || !node.value.trim()) return;
    const offset = msTicks(node.start_time);
    out.push({ offset, duration: Math.max(0, msTicks(node.end_time) - offset), text: node.value.trim() });
  };
  walk(marks);
  return out;
}

const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Characters Speechify bills: SSML tags are free, so a <speak> document is measured without them. */
const spokenLength = (text) => codePoints(/^\s*<speak/.test(text) ? text.replace(/<[^<>]*>/g, '') : text);

/**
 * Synthesize with Speechify.
 * @param {object} opts  key; model; language (BCP-47, when the text is not in the voice's locale);
 *   timings (default true): false uses the stream endpoint, which returns no word times but takes longer text.
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, { key, model = DEFAULT_MODEL, language, timings = true, fetchImpl = globalThis.fetch } = {}) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!key) throw new HttpError(503, 'Speechify voices are not configured on this server (no SPEECHIFY_API_KEY)');
  const limit = timings ? MAX_CHARS : STREAM_MAX_CHARS;
  if (spokenLength(text) > limit) throw new HttpError(422, `Text is limited to ${limit} characters per request for Speechify voices${timings ? ' with word timings' : ''}`);
  const body = { input: text, voice_id: voice.slice(PREFIX.length), model, audio_format: 'mp3' };
  if (language) body.language = language;
  const init = (accept) => ({ method: 'POST', headers: { ...headers(key, accept), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (!timings) {
    const res = await request(fetchImpl, `${API}/v1/audio/stream`, init('audio/mpeg'));
    if (!res.ok) await fail(res, model);
    const audio = new Uint8Array(await res.arrayBuffer());
    if (!audio.length) throw new HttpError(502, 'Speechify returned no audio');
    return { audio, boundaries: [] };
  }
  const res = await request(fetchImpl, `${API}/v1/audio/speech`, init('application/json'));
  if (!res.ok) await fail(res, model);
  const data = await readJson(res);
  if (!isStr(data.audio_data) || !data.audio_data) throw new HttpError(502, 'Speechify returned no audio');
  let audio;
  try { audio = base64ToBytes(data.audio_data); } catch { throw new HttpError(502, 'Speechify returned unreadable audio'); }
  return { audio, boundaries: speechMarksToBoundaries(data.speech_marks) };
}

/** For /usage: Speechify bills per character but has no usage endpoint; the console shows the balance. */
export const usage = () => ({ provider: 'speechify', unlimited: false, usageUrl: USAGE_URL });

/** The voice's preview clip, for /samples/speechify:<id>. Costs nothing. */
export async function sample(key, voice, { model = DEFAULT_MODEL, locale = DEFAULT_LOCALE, fetchImpl = globalThis.fetch } = {}) {
  const voices = await listVoices(key, { model, locale, fetchImpl });
  const found = voices.find((v) => v.shortName === voice);
  if (!found) throw new HttpError(404, 'No such Speechify voice for this workspace');
  if (!found.previewUrl) throw new HttpError(404, 'This Speechify voice has no preview clip');
  if (!/^https:\/\//i.test(found.previewUrl)) throw new HttpError(502, 'Speechify preview URL is not https');
  const res = await request(fetchImpl, found.previewUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new HttpError(502, `Speechify preview failed: HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  return { audio: new Uint8Array(await res.arrayBuffer()), contentType: /^audio\//i.test(ct) ? ct : 'audio/mpeg' };
}
