// Direct client for Microsoft Edge's read-aloud TTS: text in, MP3 + word timings out.
// Dependency-free. Works anywhere with a WebSocket that can reach the service:
//  - Node / Electron: pass { headers } via the WebSocket constructor (see makeNodeSocket)
//  - Browser extension: headers are added by declarativeNetRequest rules instead
import { generateSecMsGec, TRUSTED_CLIENT_TOKEN } from './drm.js';

const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
export const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
export const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
export const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
export const EDGE_USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`;

/** 48 kbps CBR MP3: 1 byte = 8/48000 s = 1666.67 ticks (100 ns). */
export const TICKS_PER_SECOND = 10_000_000;
const MP3_BITRATE_BPS = 48_000;
export const mp3BytesToTicks = (bytes) => Math.floor((bytes * 8 * TICKS_PER_SECOND) / MP3_BITRATE_BPS);

const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const jsDate = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, '$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)');
const escapeXml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const unescapeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
// The service rejects most C0 control characters (common in OCR'd PDFs)
const cleanText = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');

/** Full connection URL, including the time-based token. */
export function connectionUrl(unixSeconds) {
  return `${WSS_URL}&ConnectionId=${hex32()}&Sec-MS-GEC=${generateSecMsGec(unixSeconds)}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
}

/** Headers the service expects (only settable in Node/Electron or via extension rules). */
export function connectionHeaders() {
  return {
    'User-Agent': EDGE_USER_AGENT,
    Origin: EDGE_ORIGIN,
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: `muid=${hex32().toUpperCase()};`,
  };
}

function parseTextFrame(text) {
  const split = text.indexOf('\r\n\r\n');
  const headers = {};
  for (const line of text.slice(0, split).split('\r\n')) {
    const i = line.indexOf(':');
    headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return { headers, body: text.slice(split + 4) };
}

function parseBinaryFrame(buf) {
  const view = new Uint8Array(buf);
  const headerLen = (view[0] << 8) | view[1];
  const headerText = new TextDecoder().decode(view.subarray(2, 2 + headerLen));
  const headers = {};
  for (const line of headerText.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return { headers, audio: view.subarray(2 + headerLen) };
}

/**
 * Synthesize one chunk of text.
 * @param {string} text
 * @param {object} opts
 * @param {string} [opts.voice]  e.g. 'en-US-AriaNeural'
 * @param {string} [opts.rate]   e.g. '+0%', '+50%'
 * @param {(url: string) => WebSocket | Promise<WebSocket>} opts.openSocket  platform-specific socket factory
 * @param {string} [opts.url]    the service to connect to; default: Edge's endpoint with its token. Azure AI Speech
 *                               speaks the same protocol, so a server with a key passes its own endpoint here
 * @param {string} [opts.ssml]   a complete SSML document to send in place of the one built from `text`
 *                               (for providers that take real SSML: break tags, say-as, prosody)
 * @returns {Promise<{ audio: Uint8Array, boundaries: {offset:number,duration:number,text:string}[] }>}
 */
export function synthesize(text, { voice = 'en-US-AriaNeural', rate = '+0%', pitch = '+0Hz', volume = '+0%', openSocket, timeoutMs = 60000, url, ssml } = {}) {
  if (!openSocket) throw new Error('openSocket is required');
  ssml = ssml ||
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${escapeXml(voice)}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>` +
    `${escapeXml(cleanText(text))}</prosody></voice></speak>`;

  return Promise.resolve(openSocket(url || connectionUrl())).then((ws) => new Promise((resolve, reject) => {
    ws.binaryType = 'arraybuffer';
    const parts = [];
    const boundaries = [];
    let size = 0;
    // Settle once: closing a failed socket can fire error/close again (Node's WebSocket does)
    let settled = false;
    const timer = setTimeout(() => fail(new Error('TTS timed out')), timeoutMs);
    const fail = (err) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} reject(err); };

    const start = () => {
      ws.send(
        `X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},' +
        '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
      );
      ws.send(
        `X-RequestId:${hex32()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n${ssml}`
      );
    };
    // Sockets from some platforms (e.g. Cloudflare Workers) arrive already open
    if (ws.readyState === 1) start(); else ws.onopen = start;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const { headers, body } = parseTextFrame(ev.data);
        if (headers.Path === 'audio.metadata') {
          for (const m of JSON.parse(body).Metadata) {
            // Azure also reports punctuation as its own boundary; the highlighter wants words only
            if (m.Type === 'WordBoundary' && m.Data?.text?.BoundaryType !== 'PunctuationBoundary') {
              boundaries.push({ offset: m.Data.Offset, duration: m.Data.Duration, text: unescapeXml(m.Data.text.Text) });
            }
          }
        } else if (headers.Path === 'turn.end') {
          if (!size) return fail(new Error('No audio received'));
          settled = true;
          clearTimeout(timer);
          ws.close();
          const audio = new Uint8Array(size);
          let off = 0;
          for (const p of parts) { audio.set(p, off); off += p.length; }
          resolve({ audio, boundaries });
        }
      } else {
        const { headers, audio } = parseBinaryFrame(ev.data);
        if (headers.Path === 'audio' && audio.length) { parts.push(audio.slice()); size += audio.length; }
      }
    };
    ws.onerror = (ev) => fail(new Error(`WebSocket error: ${ev?.message || ev?.error?.message || 'connection failed'}`));
    ws.onclose = (ev) => { if (ev && ev.code !== 1000 && ev.code !== 1005 && !size) fail(new Error(`Closed (${ev.code}) ${ev.reason || ''}`)); };
  }));
}

/**
 * List available voices. Needs the same headers as synthesis: pass { headers } in
 * Node/Electron; in an extension the declarativeNetRequest rule supplies them.
 * @returns {Promise<{ShortName:string, Locale:string, Gender:string, FriendlyName:string}[]>}
 */
export async function listVoices({ fetchImpl = globalThis.fetch, headers } = {}) {
  const url = `${VOICES_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  const res = await fetchImpl(url, headers ? { headers } : undefined);
  if (!res.ok) throw new Error(`Voice list failed: HTTP ${res.status}`);
  return res.json();
}
