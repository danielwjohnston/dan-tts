// Google Cloud Text-to-Speech. Voice ids are "google:<name>", e.g. "google:en-US-Neural2-F".
// Word timings: the request is SSML with a <mark> before every word, and the service reports
// when each mark is reached. The Chirp and Journey voices take no SSML, so their timings are
// estimated from the clip's length instead. Needs GOOGLE_TTS_API_KEY on the server (an API key
// restricted to the Text-to-Speech API).
import { HttpError } from './extract.js';
import { inPieces, pieces, joinPieces, estimateBoundaries, mp3Ticks, ssmlWithMarks, cleanText, request, readJson, errorBody, localesOf, base64ToBytes, TICKS } from './audio.js';

export const PREFIX = 'google:';
export const ID_RE = /^google:[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9-]{1,60}$/;
export const MAX_CHARS = 4000; // plain text per request (the API takes 5,000 bytes)
export const MAX_MARKED_CHARS = 1000; // with a mark before every word; the SSML is kept under the byte limit
const SSML_BYTES = 4800;
const API = 'https://texttospeech.googleapis.com/v1';
const NAME = 'Google Cloud Text-to-Speech';

export const isGoogleVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
const configured = (env) => !!env.GOOGLE_TTS_API_KEY;
/** Voices that take SSML, and so can report word timings. */
export const takesSsml = (name) => !/Chirp|Journey/i.test(name);
const GENDERS = { MALE: 'Male', FEMALE: 'Female' };
const headers = (env) => ({ 'x-goog-api-key': env.GOOGLE_TTS_API_KEY, 'Content-Type': 'application/json' });

async function fail(res) {
  const err = (await errorBody(res)).error || {};
  const message = typeof err.message === 'string' ? err.message : '';
  if (res.status === 401 || res.status === 403 || /API key/i.test(message)) return new HttpError(502, `${NAME} rejected the API key${message ? ` (${message})` : ''}: check GOOGLE_TTS_API_KEY on the server`);
  if (res.status === 429) return new HttpError(429, `${NAME} quota is used up or requests are being rate-limited; try again later. Edge voices still work`);
  if (res.status === 400 && /voice/i.test(message)) return new HttpError(400, `No such ${NAME} voice${message ? ` (${message})` : ''}`);
  if (res.status === 400 && /5000 bytes|too long|limit/i.test(message)) return new HttpError(422, `Text is too long for ${NAME} in one request`);
  if (res.status === 400) return new HttpError(400, `${NAME} rejected the request${message ? `: ${message}` : ''}`);
  return new HttpError(502, `${NAME} error: HTTP ${res.status}${message ? ` (${message})` : ''}`);
}

/** The voices for the configured locales, in the shape /voices returns for Edge voices. Listing is free. */
export async function listVoices(env, { fetchImpl = globalThis.fetch } = {}) {
  const locales = localesOf(env);
  const out = [];
  const seen = new Set();
  for (const locale of locales.length ? locales : ['']) {
    const res = await request(fetchImpl, NAME, `${API}/voices${locale ? `?languageCode=${encodeURIComponent(locale)}` : ''}`, { headers: headers(env), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw await fail(res);
    const data = await readJson(res, NAME);
    for (const v of Array.isArray(data.voices) ? data.voices : []) {
      if (!v || typeof v.name !== 'string' || seen.has(v.name) || !ID_RE.test(PREFIX + v.name)) continue;
      seen.add(v.name);
      const code = (Array.isArray(v.languageCodes) && v.languageCodes[0]) || v.name.match(/^[A-Za-z]{2,3}-[A-Za-z]{2,4}/)?.[0] || '';
      out.push({
        name: v.name.replace(/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-/, '').replace(/-/g, ' '),
        shortName: `${PREFIX}${v.name}`,
        locale: code,
        localeName: takesSsml(v.name) ? code : `${code} · Timings estimated`,
        gender: GENDERS[v.ssmlGender] || '',
        styleList: [],
        provider: 'google',
        sampleUrl: `/samples/${PREFIX}${v.name}`,
      });
    }
  }
  return out;
}

/** Word boundaries from the marks the service reached, each lasting until the next (the last until the clip ends). */
export function timepointsToBoundaries(timepoints, words, totalTicks) {
  const at = new Map();
  for (const t of Array.isArray(timepoints) ? timepoints : []) {
    const i = Number(t?.markName);
    if (Number.isInteger(i) && i >= 0 && i < words.length && typeof t.timeSeconds === 'number') at.set(i, Math.floor(t.timeSeconds * TICKS + 0.5));
  }
  const indexes = [...at.keys()].sort((a, b) => a - b);
  return indexes.map((i, k) => {
    const offset = at.get(i);
    const next = k + 1 < indexes.length ? at.get(indexes[k + 1]) : totalTicks;
    return { offset, duration: Math.max(0, next - offset), text: words[i] };
  });
}

/** The pieces of a marked-up text, each small enough for the byte limit once every word carries a mark. */
export function markedPieces(text, max = MAX_MARKED_CHARS) {
  const out = [];
  for (const piece of pieces(text, max)) {
    if (new TextEncoder().encode(ssmlWithMarks(piece).body).length <= SSML_BYTES || max <= 100) out.push(piece);
    else out.push(...markedPieces(piece, Math.floor(max / 2)));
  }
  return out;
}

/**
 * Synthesize with Google.
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, env, { fetchImpl = globalThis.fetch } = {}) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!configured(env)) throw new HttpError(503, `${NAME} voices are not configured on this server (no GOOGLE_TTS_API_KEY)`);
  const name = voice.slice(PREFIX.length);
  const languageCode = name.match(/^[A-Za-z]{2,3}-[A-Za-z]{2,4}/)[0];
  const marks = takesSsml(name);
  const one = async (piece) => {
    const marked = marks ? ssmlWithMarks(piece) : null;
    const body = {
      input: marked ? { ssml: `<speak>${marked.body}</speak>` } : { text: cleanText(piece) },
      voice: { languageCode, name },
      audioConfig: { audioEncoding: 'MP3' },
      ...(marked ? { enableTimePointing: ['SSML_MARK'] } : {}),
    };
    const res = await request(fetchImpl, NAME, `${API}/text:synthesize`, { method: 'POST', headers: headers(env), body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw await fail(res);
    const data = await readJson(res, NAME);
    if (typeof data.audioContent !== 'string' || !data.audioContent) throw new HttpError(502, `${NAME} returned no audio`);
    let audio;
    try { audio = base64ToBytes(data.audioContent); } catch { throw new HttpError(502, `${NAME} returned unreadable audio`); }
    const ticks = mp3Ticks(audio);
    const boundaries = marked ? timepointsToBoundaries(data.timepoints, marked.words, ticks) : estimateBoundaries(piece, ticks);
    return { audio, boundaries };
  };
  if (!marks) return inPieces(text, MAX_CHARS, one);
  const parts = [];
  for (const piece of markedPieces(text)) parts.push(await one(piece));
  if (!parts.length) throw new HttpError(400, 'Text is required');
  return joinPieces(parts);
}

export const provider = {
  id: 'google', name: NAME, PREFIX, ID_RE, isVoice: isGoogleVoice, configured,
  unconfigured: `${NAME} voices are not configured on this server (no GOOGLE_TTS_API_KEY)`,
  timings: 'exact', listVoices, synthesize,
};
