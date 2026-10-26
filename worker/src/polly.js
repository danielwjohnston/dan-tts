// Amazon Polly. Voice ids are "polly:<VoiceId>", e.g. "polly:Joanna". Each piece of text is two
// signed requests: the MP3, and the word speech marks that give exact word timings. Requests
// are signed with AWS Signature Version 4 here (no SDK). Needs AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY on the server; AWS_REGION defaults to us-east-1; POLLY_ENGINE picks the
// engine (default neural, with a fallback to standard for voices that lack it).
import { HttpError } from './extract.js';
import { inPieces, hasBreaks, ssmlBody, cleanText, mp3Ticks, request, readJson, errorBody, localesOf, localeOk } from './audio.js';

export const PREFIX = 'polly:';
export const ID_RE = /^polly:[A-Za-z0-9_-]{2,40}$/;
export const MAX_CHARS = 2500; // billed characters per request (the API takes 3,000)
export const DEFAULT_ENGINE = 'neural';
export const DEFAULT_REGION = 'us-east-1';
const NAME = 'Amazon Polly';

export const isPollyVoice = (voice) => typeof voice === 'string' && voice.startsWith(PREFIX);
const configured = (env) => !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
const region = (env) => String(env.AWS_REGION || DEFAULT_REGION).trim();
const endpoint = (env) => `https://polly.${region(env)}.amazonaws.com`;

// ---- AWS Signature Version 4 ----
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const amzDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The derived signing key for a day, region and service. */
export async function signingKey(secret, day, reg, service) {
  let k = await hmac(`AWS4${secret}`, day);
  for (const part of [reg, service, 'aws4_request']) k = await hmac(k, part);
  return k;
}

/** Headers that sign a request (SigV4, service "polly"): x-amz-date, x-amz-content-sha256, Authorization and, with temporary credentials, x-amz-security-token. */
export async function signV4({ method, url, body = '', env, now = new Date() }) {
  const u = new URL(url);
  const date = amzDate(now), day = date.slice(0, 8), reg = region(env);
  const payloadHash = await sha256(body);
  const headers = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date };
  if (env.AWS_SESSION_TOKEN) headers['x-amz-security-token'] = env.AWS_SESSION_TOKEN;
  const names = Object.keys(headers).sort();
  const canonicalQuery = [...u.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, u.pathname.split('/').map(rfc3986).join('/'), canonicalQuery, ...names.map((n) => `${n}:${headers[n].trim()}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${reg}/polly/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, await sha256(canonical)].join('\n');
  const signature = hex(await hmac(await signingKey(env.AWS_SECRET_ACCESS_KEY, day, reg, 'polly'), toSign));
  const { host, ...out } = headers; // fetch sets Host itself
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return out;
}

async function fail(res) {
  const type = (res.headers.get('x-amzn-errortype') || '').split(':')[0] || '';
  const body = await errorBody(res);
  const message = typeof body.message === 'string' ? body.message : typeof body.Message === 'string' ? body.Message : '';
  const kind = type || (typeof body.__type === 'string' ? body.__type.split('#').pop() : '');
  if (res.status === 403 || /InvalidSignature|UnrecognizedClient|InvalidClientTokenId|AccessDenied/i.test(kind)) return new HttpError(502, `${NAME} rejected the credentials${message ? ` (${message})` : ''}: check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION on the server`);
  if (/TextLengthExceeded/i.test(kind)) return new HttpError(422, `Text is too long for ${NAME} in one request (limit about ${MAX_CHARS} characters)`);
  if (res.status === 429 || /Throttling|LimitExceeded/i.test(kind)) return new HttpError(429, `${NAME} is rate-limiting requests; try again in a moment`);
  if (/InvalidSsml|SsmlMarksNotSupported/i.test(kind)) return new HttpError(400, `${NAME} rejected the SSML${message ? ` (${message})` : ''}`);
  if (/EngineNotSupported/i.test(kind)) return new HttpError(400, `This ${NAME} voice does not support the ${DEFAULT_ENGINE} engine${message ? ` (${message})` : ''}`);
  if (res.status === 400 && /ValidationException|voice/i.test(kind + message)) return new HttpError(400, `No such ${NAME} voice${message ? ` (${message})` : ''}`);
  return new HttpError(502, `${NAME} error: HTTP ${res.status}${kind ? ` ${kind}` : ''}${message ? ` (${message})` : ''}`);
}

async function call(env, fetchImpl, path, { method = 'GET', body = '', timeout = 60000 } = {}) {
  const url = `${endpoint(env)}${path}`;
  const signed = await signV4({ method, url, body, env });
  return request(fetchImpl, NAME, url, { method, headers: { ...signed, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined, signal: AbortSignal.timeout(timeout) });
}

/** The voices for the configured locales, in the shape /voices returns for Edge voices. Listing is free. */
export async function listVoices(env, { fetchImpl = globalThis.fetch } = {}) {
  const locales = localesOf(env);
  const out = [];
  const seen = new Set();
  for (const locale of locales.length ? locales : ['']) {
    let token = '';
    for (let page = 0; page < 10; page++) {
      const q = new URLSearchParams();
      if (locale) q.set('LanguageCode', locale);
      if (token) q.set('NextToken', token);
      const res = await call(env, fetchImpl, `/v1/voices${q.toString() ? `?${q}` : ''}`, { timeout: 20000 });
      if (!res.ok) throw await fail(res);
      const data = await readJson(res, NAME);
      for (const v of Array.isArray(data.Voices) ? data.Voices : []) {
        if (!v || typeof v.Id !== 'string' || seen.has(v.Id) || !ID_RE.test(PREFIX + v.Id) || !localeOk(locales, v.LanguageCode)) continue;
        seen.add(v.Id);
        const engines = Array.isArray(v.SupportedEngines) ? v.SupportedEngines : [];
        out.push({
          name: v.Name || v.Id,
          shortName: `${PREFIX}${v.Id}`,
          locale: v.LanguageCode || '',
          localeName: [v.LanguageName, engines.includes('neural') ? '' : engines.join('/')].filter(Boolean).join(' · '),
          gender: v.Gender || '',
          styleList: [],
          provider: 'polly',
          sampleUrl: `/samples/${PREFIX}${v.Id}`,
        });
      }
      token = typeof data.NextToken === 'string' ? data.NextToken : '';
      if (!token) break;
    }
  }
  return out;
}

/** Word speech marks (one JSON object per line) → word boundaries, each lasting until the next word (the last until the clip ends). */
export function marksToBoundaries(marksText, totalTicks) {
  const marks = [];
  for (const line of String(marksText).split('\n')) {
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m && m.type === 'word' && typeof m.time === 'number' && typeof m.value === 'string') marks.push(m); } catch {}
  }
  return marks.map((m, i) => {
    const offset = m.time * 10000;
    const next = i + 1 < marks.length ? marks[i + 1].time * 10000 : totalTicks;
    return { offset, duration: Math.max(0, next - offset), text: m.value };
  });
}

/**
 * Synthesize with Polly: audio and word marks for each piece of text, in parallel.
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export async function synthesize(text, voice, env, { fetchImpl = globalThis.fetch } = {}) {
  if (!ID_RE.test(voice)) throw new HttpError(400, 'Invalid voice name');
  if (!configured(env)) throw new HttpError(503, `${NAME} voices are not configured on this server (no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)`);
  const VoiceId = voice.slice(PREFIX.length);
  let engine = env.POLLY_ENGINE || DEFAULT_ENGINE;
  return inPieces(text, MAX_CHARS, async (piece) => {
    const ssml = hasBreaks(piece);
    const base = { Engine: engine, VoiceId, Text: ssml ? `<speak>${ssmlBody(piece, { maxMs: 5000 })}</speak>` : cleanText(piece), TextType: ssml ? 'ssml' : 'text' };
    const speak = (extra) => call(env, fetchImpl, '/v1/speech', { method: 'POST', body: JSON.stringify({ ...base, ...extra }) });
    let [audioRes, marksRes] = await Promise.all([speak({ OutputFormat: 'mp3' }), speak({ OutputFormat: 'json', SpeechMarkTypes: ['word'] })]);
    if (!audioRes.ok && engine !== 'standard' && /EngineNotSupported/i.test(audioRes.headers.get('x-amzn-errortype') || '')) {
      // The voice lacks this engine: the rest of the request uses the standard one
      engine = 'standard';
      base.Engine = engine;
      [audioRes, marksRes] = await Promise.all([speak({ OutputFormat: 'mp3' }), speak({ OutputFormat: 'json', SpeechMarkTypes: ['word'] })]);
    }
    if (!audioRes.ok) throw await fail(audioRes);
    if (!marksRes.ok) throw await fail(marksRes);
    const audio = new Uint8Array(await audioRes.arrayBuffer());
    if (!audio.length) throw new HttpError(502, `${NAME} returned no audio`);
    return { audio, boundaries: marksToBoundaries(await marksRes.text(), mp3Ticks(audio)) };
  });
}

export const provider = {
  id: 'polly', name: NAME, PREFIX, ID_RE, isVoice: isPollyVoice, configured,
  unconfigured: `${NAME} voices are not configured on this server (no AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)`,
  timings: 'exact', listVoices, synthesize,
};
