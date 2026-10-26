// Azure AI Speech as a voice provider. Voice ids are "azure:<ShortName>" (azure:en-US-JennyNeural), so
// the rest of the server can route by prefix. The service speaks the same WebSocket protocol as Edge's
// Read Aloud, so the shared engine does the work with Azure's URL and a key header in place of Edge's
// token, and the word boundaries come back in the same shape (100 ns ticks). The key and the region
// live on the server only.
import { synthesize as speak, listVoices as fetchVoices } from '../../engine/src/tts.js';
import { HttpError } from './extract.js';

export const PREFIX = 'azure:';
// Short names like en-US-JennyNeural. HD voices ("en-US-Ava:DragonHDLatestNeural") are left out: they are
// priced differently and their names do not fit the rest of the server's voice name rules.
export const ID_RE = /^azure:[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+$/;
const REGION_RE = /^[a-z0-9]{2,32}$/; // region identifiers such as eastus or westeurope
export const NOT_CONFIGURED = 'Azure voices are not configured on this server (set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)';
export const USAGE_NOTE = 'Azure reports usage in its portal; the free tier is 500,000 characters a month';

export const isAzureVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
export const configured = (env) => Boolean(env?.AZURE_SPEECH_KEY && env?.AZURE_SPEECH_REGION);
const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

function host(region) {
  const r = String(region || '').trim().toLowerCase();
  if (!REGION_RE.test(r)) throw new HttpError(503, 'AZURE_SPEECH_REGION is not a region identifier (for example eastus)');
  return `${r}.tts.speech.microsoft.com`;
}
/** The synthesis socket: Azure wants a connection id (a GUID without dashes) and no Edge token. */
export const connectionUrl = (region) => `wss://${host(region)}/cognitiveservices/websocket/v1?X-ConnectionId=${hex32()}`;
export const voiceListUrl = (region) => `https://${host(region)}/cognitiveservices/voices/list`;
/** The header that carries the key, on the socket handshake and the voice list alike. */
export const headers = (key) => ({ 'Ocp-Apim-Subscription-Key': key });

/** A refused response (socket handshake or voice list) in plain words. */
export function refused(status) {
  if (status === 401 || status === 403) return new HttpError(502, 'Azure rejected the key or region: check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION on the server');
  if (status === 429) return new HttpError(429, 'Azure is rate-limiting requests; try again in a moment');
  return new HttpError(502, `Azure error: HTTP ${status}`);
}

/** Anything else that fails on the way to Azure becomes an HttpError, never a bare throw (which would be a 500). */
export function toHttpError(e) {
  if (e instanceof HttpError) return e;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed out/i.test(e?.message || '')) return new HttpError(504, 'Azure timed out');
  if (e instanceof SyntaxError) return new HttpError(502, 'Azure returned an unreadable response');
  return new HttpError(502, `Azure error: ${e?.message || e}`);
}

// "en-US-JennyMultilingualNeural" → "Jenny Multilingual", when the listing has no DisplayName
const friendly = (shortName) => String(shortName || '').split('-').slice(2).join('-').replace(/Neural$/, '').replace(/Multilingual$/, ' Multilingual');
const lists = (v) => v && typeof v === 'object' && /^en-/i.test(v.Locale || '') && v.Status !== 'Deprecated' && ID_RE.test(`${PREFIX}${v.ShortName}`);

/**
 * The English voices of the region, in the shape /voices returns for Edge voices. Listing costs nothing.
 * en-US first, then the other English locales in the order Azure lists them.
 */
export async function listVoices(key, region, { fetchImpl = globalThis.fetch } = {}) {
  const url = voiceListUrl(region);
  const checked = async (u, init) => {
    const res = await fetchImpl(u, { ...init, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw refused(res.status);
    return res;
  };
  let data;
  try { data = await fetchVoices({ fetchImpl: checked, headers: headers(key), voiceListUrl: url }); }
  catch (e) { throw toHttpError(e); }
  if (!Array.isArray(data)) throw new HttpError(502, 'Azure returned an unreadable voice list');
  return data.filter(lists).map((v) => ({
    name: v.DisplayName || friendly(v.ShortName),
    shortName: `${PREFIX}${v.ShortName}`,
    locale: v.Locale,
    localeName: v.LocaleName || '',
    gender: v.Gender || '',
    styleList: Array.isArray(v.StyleList) ? v.StyleList : [],
    provider: 'azure',
    sampleUrl: `/samples/${PREFIX}${v.ShortName}`,
  })).sort((a, b) => (a.locale === 'en-US' ? 0 : 1) - (b.locale === 'en-US' ? 0 : 1));
}

/**
 * Synthesize with Azure through the shared engine. openSocket is the platform's socket factory and must
 * send headers(key) on the handshake (the Worker's does; see index.js).
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, { key, region, openSocket } = {}) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!key || !region) throw new HttpError(503, NOT_CONFIGURED);
  const url = connectionUrl(region);
  try {
    return await speak(text, { voice: voice.slice(PREFIX.length), openSocket, connectionUrl: url });
  } catch (e) {
    throw toHttpError(e);
  }
}
