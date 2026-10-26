// Azure AI Speech (Microsoft's licensed service). Voice ids are "azure:<ShortName>", e.g.
// "azure:en-US-JennyNeural". The official WebSocket endpoint speaks the same protocol as the
// shared engine, so synthesis is the engine with Azure's URL, a key header and real SSML (break
// tags from the markup editor). Word timings come from the service itself. Needs
// AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (e.g. "eastus") on the server.
import { synthesize as engineSynthesize } from '../../engine/src/tts.js';
import { HttpError } from './extract.js';
import { inPieces, ssmlBody, request, readJson, localesOf, localeOk, hex32 } from './audio.js';

export const PREFIX = 'azure:';
export const ID_RE = /^azure:[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9:-]{3,80}$/;
export const MAX_CHARS = 8000; // per WebSocket turn (the service caps a turn at ten minutes of audio)
const NAME = 'Azure AI Speech';

export const isAzureVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
const host = (env) => `${String(env.AZURE_SPEECH_REGION).trim()}.tts.speech.microsoft.com`;
const configured = (env) => !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION);
const title = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function fail(status, message) {
  if (status === 401 || status === 403) return new HttpError(502, `${NAME} rejected the key or region${message ? ` (${message})` : ''}: check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION on the server`);
  if (status === 429) return new HttpError(429, `${NAME} is rate-limiting requests; try again in a moment`);
  return new HttpError(502, `${NAME} error: HTTP ${status}${message ? ` (${message})` : ''}`);
}

/** The region's voices, in the shape /voices returns for Edge voices. Listing is free. */
export async function listVoices(env, { fetchImpl = globalThis.fetch } = {}) {
  const res = await request(fetchImpl, NAME, `https://${host(env)}/cognitiveservices/voices/list`, {
    headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY }, signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw fail(res.status, (await res.text().catch(() => '')).slice(0, 120));
  let list;
  try { list = await res.json(); } catch { throw new HttpError(502, `${NAME} returned an unreadable response`); }
  if (!Array.isArray(list)) throw new HttpError(502, `${NAME} returned an unreadable response`);
  const locales = localesOf(env);
  return list.filter((v) => v && typeof v.ShortName === 'string' && localeOk(locales, v.Locale) && ID_RE.test(PREFIX + v.ShortName)).map((v) => ({
    name: v.DisplayName || v.LocalName || v.ShortName,
    shortName: `${PREFIX}${v.ShortName}`,
    locale: v.Locale || '',
    localeName: [v.LocaleName, v.VoiceType && v.VoiceType !== 'Neural' ? v.VoiceType : ''].filter(Boolean).join(' · '),
    gender: title(v.Gender || ''),
    styleList: Array.isArray(v.StyleList) ? v.StyleList : [],
    provider: 'azure',
    sampleUrl: `/samples/${PREFIX}${v.ShortName}`,
  }));
}

/** The SSML document for one piece of text: the voice's own language, break tags kept. */
export function ssmlFor(text, shortName) {
  const lang = shortName.match(/^([A-Za-z]{2,3}-[A-Za-z]{2,4})/)?.[1] || 'en-US';
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='${lang}'>` +
    `<voice name='${shortName}'>${ssmlBody(text, { maxMs: 5000 })}</voice></speak>`;
}

/**
 * Synthesize with Azure. openSocket(url, headers) opens the platform's WebSocket with the key header.
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, env, { openSocket } = {}) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!configured(env)) throw new HttpError(503, `${NAME} voices are not configured on this server (no AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)`);
  if (!openSocket) throw new Error('openSocket is required');
  const shortName = voice.slice(PREFIX.length);
  const headers = { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY };
  return inPieces(text, MAX_CHARS, async (piece) => {
    const url = `wss://${host(env)}/cognitiveservices/websocket/v1?X-ConnectionId=${hex32()}`;
    try {
      return await engineSynthesize(piece, { voice: shortName, url, ssml: ssmlFor(piece, shortName), openSocket: (u) => openSocket(u, headers) });
    } catch (e) {
      if (e instanceof HttpError) {
        const status = e.message.match(/HTTP (\d{3})/)?.[1];
        throw status ? fail(Number(status), '') : e;
      }
      if (/timed out/i.test(e.message)) throw new HttpError(504, `${NAME} timed out`);
      throw new HttpError(502, `${NAME} error: ${e.message}`);
    }
  });
}

export const provider = {
  id: 'azure', name: NAME, PREFIX, ID_RE, isVoice: isAzureVoice, configured,
  unconfigured: `${NAME} voices are not configured on this server (no AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)`,
  timings: 'exact', listVoices, synthesize,
};
