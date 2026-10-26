// Voices served by the project's own API (the Cloudflare Worker, or the Python server).
// Licensed providers such as ElevenLabs sit behind it and their keys stay there; Edge voices
// never go through it. Shared by the browser extension, the desktop app and their tests.

export const DEFAULT_SERVER = 'https://dan-tts.macdaddydwj.workers.dev';

/** Provider voice ids carry a prefix ("eleven:<id>"); Edge ids ("en-US-AriaNeural") have no colon. */
export const isServerVoice = (voice) => /^[a-z][a-z0-9]*:/i.test(String(voice || ''));

/**
 * The server for a stored setting: unset → the default; empty → none (server voices are off);
 * otherwise the URL without a trailing slash.
 */
export function serverFor(setting) {
  if (setting === undefined || setting === null) return DEFAULT_SERVER;
  return String(setting).trim().replace(/\/+$/, '');
}

const LABELS = { elevenlabs: 'ElevenLabs' };
export const providerLabel = (provider) => LABELS[provider] || (provider ? provider[0].toUpperCase() + provider.slice(1) : 'Server');

/** The server's own explanation of a failure ({"detail": "..."}), else the status. */
async function reason(res) {
  try { const d = (await res.json())?.detail; if (typeof d === 'string' && d) return d; } catch {}
  return `HTTP ${res.status}`;
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

/** fetch whose network failures say which server could not be reached and what to do about it. */
async function reach(fetchImpl, base, path, init) {
  try {
    return await fetchImpl(`${base}${path}`, init);
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new Error(`${timedOut ? 'The voice server did not answer in time' : 'Could not reach the voice server'} (${hostOf(base)}). Pick an Edge voice, or check the server on the options page.`);
  }
}

/**
 * Provider voices from the server, in the shape the reader's voice picker uses for Edge
 * voices (capitalised fields) plus Provider. Edge voices are left out: the reader lists those itself.
 */
export async function listServerVoices(server, { fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const base = serverFor(server);
  if (!base) return [];
  const res = await reach(fetchImpl, base, '/voices', { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Voice server: ${await reason(res)}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('Voice server returned an unexpected voice list');
  return list
    .filter((v) => v && typeof v.shortName === 'string' && v.provider && v.provider !== 'edge' && isServerVoice(v.shortName))
    .map((v) => ({ ShortName: v.shortName, Locale: v.locale || '', LocaleName: v.localeName || '', Gender: v.gender || '', FriendlyName: v.name || v.shortName, Provider: v.provider }));
}

/**
 * Speech from the server, in the same { audio, boundaries } shape as synthesize() (boundaries in
 * 100 ns ticks), plus the audio's contentType. Errors carry the server's plain-language reason.
 */
export async function synthesizeServer(text, { voice, server, fetchImpl = globalThis.fetch, timeoutMs = 90000 } = {}) {
  const base = serverFor(server);
  if (!base) throw new Error('Server voices are turned off (no voice server is set)');
  const res = await reach(fetchImpl, base, '/synthesize_with_timing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, format: 'mp3' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(await reason(res));
  const data = await res.json();
  if (typeof data?.audio !== 'string' || !data.audio || !Array.isArray(data.boundaries)) throw new Error('Voice server returned no audio');
  let bin;
  try { bin = atob(data.audio); } catch { throw new Error('Voice server returned unreadable audio'); }
  const audio = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) audio[i] = bin.charCodeAt(i);
  const boundaries = data.boundaries.map((b) => ({ offset: Number(b?.offset) || 0, duration: Number(b?.duration) || 0, text: String(b?.text ?? '') }));
  return { audio, boundaries, contentType: typeof data.contentType === 'string' && data.contentType ? data.contentType : 'audio/mpeg' };
}
