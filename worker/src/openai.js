// OpenAI text to speech. Voice ids are "openai:<voice>", e.g. "openai:alloy". The API returns
// audio only, no word timings, so the highlighter gets timings estimated from the clip's length
// and the words' lengths (good enough to follow, never exact). Needs OPENAI_API_KEY on the server;
// OPENAI_TTS_MODEL picks the model (default gpt-4o-mini-tts).
import { HttpError } from './extract.js';
import { inPieces, estimateBoundaries, mp3Ticks, request, errorBody, cleanText } from './audio.js';

export const PREFIX = 'openai:';
export const ID_RE = /^openai:[a-z]{3,20}$/;
export const DEFAULT_MODEL = 'gpt-4o-mini-tts';
export const MAX_CHARS = 4000; // the API takes 4096 per request
const API = 'https://api.openai.com';
const NAME = 'OpenAI';
// The API has no voice listing; these are the voices it documents, in its order
export const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];

export const isOpenAIVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
const configured = (env) => !!env.OPENAI_API_KEY;
const title = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

async function fail(res) {
  const err = (await errorBody(res)).error || {};
  const message = typeof err.message === 'string' ? err.message : '';
  if (res.status === 401) return new HttpError(502, `${NAME} rejected the API key${message ? ` (${message})` : ''}: check OPENAI_API_KEY on the server`);
  if (res.status === 429 && (err.type === 'insufficient_quota' || err.code === 'insufficient_quota')) return new HttpError(429, `The ${NAME} account is out of credit. Edge voices still work; add credit on platform.openai.com`);
  if (res.status === 429) return new HttpError(429, `${NAME} is rate-limiting requests; try again in a moment`);
  if (res.status === 400 && err.param === 'voice') return new HttpError(400, `No such ${NAME} voice`);
  if (res.status === 400 && err.param === 'input') return new HttpError(422, `Text is too long for ${NAME} in one request (limit about ${MAX_CHARS} characters)`);
  if (res.status === 400) return new HttpError(400, `${NAME} rejected the request${message ? `: ${message}` : ''}`);
  return new HttpError(502, `${NAME} error: HTTP ${res.status}${message ? ` (${message})` : ''}`);
}

/** The documented voices, in the shape /voices returns for Edge voices. No network. */
export async function listVoices() {
  return VOICES.map((v) => ({
    name: title(v), shortName: `${PREFIX}${v}`, locale: '', localeName: 'Timings estimated', gender: '', styleList: [],
    provider: 'openai', sampleUrl: `/samples/${PREFIX}${v}`,
  }));
}

/**
 * Synthesize with OpenAI.
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, env, { fetchImpl = globalThis.fetch } = {}) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!configured(env)) throw new HttpError(503, `${NAME} voices are not configured on this server (no OPENAI_API_KEY)`);
  const name = voice.slice(PREFIX.length);
  return inPieces(text, MAX_CHARS, async (piece) => {
    const res = await request(fetchImpl, NAME, `${API}/v1/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.OPENAI_TTS_MODEL || DEFAULT_MODEL, input: cleanText(piece), voice: name, response_format: 'mp3' }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw await fail(res);
    const audio = new Uint8Array(await res.arrayBuffer());
    if (!audio.length) throw new HttpError(502, `${NAME} returned no audio`);
    return { audio, boundaries: estimateBoundaries(piece, mp3Ticks(audio)) };
  });
}

export const provider = {
  id: 'openai', name: NAME, PREFIX, ID_RE, isVoice: isOpenAIVoice, configured,
  unconfigured: `${NAME} voices are not configured on this server (no OPENAI_API_KEY)`,
  timings: 'estimated', listVoices, synthesize,
};
