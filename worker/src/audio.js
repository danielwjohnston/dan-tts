// Shared by the hosted voice providers: MP3 frame walking (how long a clip plays, and clean
// joins of several clips), estimated word timings for providers that report none, splitting
// text into pieces a provider accepts in one request, SSML escaping that keeps break tags,
// and fetch wrappers that turn network trouble into plain-language HttpErrors. The Python
// server has the same functions in app/providers/common.py; change both together.
import { HttpError } from './extract.js';

export const TICKS = 10_000_000; // ticks (100 ns) per second: the unit of every word boundary

// ---- MP3 frames (Layer III, which is what every provider returns) ----
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }; // by version bits
const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** The frame header at i, or null when the bytes there are not one. */
function frameAt(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (b[i + 1] >> 1) & 3; // 1 = Layer III
  const bitrate = b[i + 2] >> 4, rate = (b[i + 2] >> 2) & 3, padding = (b[i + 2] >> 1) & 1;
  if (version === 1 || layer !== 1 || bitrate === 0 || bitrate === 15 || rate === 3) return null;
  const sampleRate = SAMPLE_RATES[version][rate];
  const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrate];
  const samples = version === 3 ? 1152 : 576;
  return { length: Math.floor((samples / 8) * kbps * 1000 / sampleRate) + padding, samples, sampleRate };
}

const isTag = (b, i) => i + 3 <= b.length && b[i] === 0x54 && b[i + 1] === 0x41 && b[i + 2] === 0x47; // ID3v1 "TAG"

/**
 * Walk an MP3: its frames alone (ID3 tags and anything else dropped, so clips join cleanly) and
 * how long they play, in ticks. Bytes that are not Layer III frames give { frames: empty, ticks: 0 }.
 */
export function mp3Frames(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let i = 0;
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // "ID3" header: a syncsafe size, plus a footer when flagged
    i = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);
  }
  const parts = [];
  let size = 0, ticks = 0;
  while (i + 4 <= b.length) {
    const f = frameAt(b, i);
    // A frame is believed when another frame, the end, or an ID3v1 tag follows it: a lone sync word in junk is not one
    if (!f || i + f.length > b.length || !(i + f.length + 4 > b.length || frameAt(b, i + f.length) || isTag(b, i + f.length))) { i++; continue; }
    parts.push(b.subarray(i, i + f.length));
    size += f.length;
    ticks += Math.floor(f.samples * TICKS / f.sampleRate);
    i += f.length;
  }
  const frames = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { frames.set(p, o); o += p.length; }
  return { frames, ticks };
}

/** How long a clip plays, in ticks (0 when the bytes cannot be read as MP3). */
export const mp3Ticks = (bytes) => mp3Frames(bytes).ticks;

/**
 * One clip from the pieces of a longer text: frames only, each piece's boundaries shifted by
 * the playing time of the pieces before it. A piece that is not readable MP3 is kept as it is
 * and adds no time (its words then share the previous piece's end).
 */
export function joinPieces(pieces) {
  if (pieces.length === 1) return { audio: pieces[0].audio, boundaries: pieces[0].boundaries, ticks: mp3Ticks(pieces[0].audio) };
  const audios = [];
  const boundaries = [];
  let total = 0, size = 0;
  for (const p of pieces) {
    const { frames, ticks } = mp3Frames(p.audio);
    const audio = frames.length ? frames : p.audio;
    audios.push(audio);
    size += audio.length;
    for (const b of p.boundaries) boundaries.push({ offset: b.offset + total, duration: b.duration, text: b.text });
    total += ticks;
  }
  const audio = new Uint8Array(size);
  let o = 0;
  for (const a of audios) { audio.set(a, o); o += a.length; }
  return { audio, boundaries, ticks: total };
}

// ---- Estimated word timings, for providers that report none (OpenAI; Google's Chirp voices) ----
// Each word takes time in proportion to its letters, plus a gap; sentence and clause ends add a
// pause. Good enough to follow along; never as exact as a provider's own timings.
const WORD_CHAR = /[\p{L}\p{N}]/gu;
const SENTENCE_END = /[.!?…]["')\]]*$/u, CLAUSE_END = /[,;:—–-]["')\]]*$/u;

export function estimateBoundaries(text, totalTicks) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length || !(totalTicks > 0)) return [];
  const weights = words.map((w) => {
    const letters = (w.match(WORD_CHAR) || []).length;
    return [Math.max(1, letters) + 1, SENTENCE_END.test(w) ? 3 : CLAUSE_END.test(w) ? 1.5 : 0];
  });
  const sum = weights.reduce((s, [w, p]) => s + w + p, 0);
  let cum = 0;
  return words.map((text, i) => {
    const [w, p] = weights[i];
    const offset = Math.floor(totalTicks * cum / sum);
    cum += w;
    const end = Math.floor(totalTicks * cum / sum);
    cum += p;
    return { offset, duration: end - offset, text };
  });
}

// ---- Text pieces ----
// A dot between digits (3.50, a <break time="1.5s" /> tag) is not a sentence end
const SENTENCES = /(?:[^.!?]|(?<=\d)\.(?=\d))+(?:[.!?]+["')\]]*\s*|$)/g;
const BREAK_TAG = /<break\s+time="(\d+(?:\.\d+)?)\s*(ms|s)"\s*\/>/gi;

/** Where to cut a run of text at or before max: after whitespace, never inside a break tag. */
function cutPoint(s, max) {
  let cut = s.lastIndexOf(' ', max);
  if (cut <= 0) cut = max;
  const open = s.lastIndexOf('<break', cut);
  if (open >= 0 && s.indexOf('/>', open) >= cut) cut = open > 0 ? open : max; // the tag straddles the cut: cut before it
  return cut;
}

function splitLong(para, max) {
  const out = [];
  let cur = '';
  for (const s of para.match(SENTENCES) || [para]) {
    if (cur && (cur + s).length > max) { out.push(cur.trim()); cur = ''; }
    if (s.length > max) {
      let rest = s;
      while (rest.length > max) {
        const cut = cutPoint(rest, max);
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut);
      }
      cur = rest;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Text in pieces of at most max characters, each a request of its own: whole paragraphs where
 * they fit (short ones merged), else sentences, else words. Every word is kept.
 */
export function pieces(text, max) {
  const out = [];
  let cur = '';
  for (const p of String(text).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
    for (const piece of p.length > max ? splitLong(p, max) : [p]) {
      if (cur && cur.length + piece.length + 2 > max) { out.push(cur); cur = ''; }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Synthesize text piece by piece with fn(piece) → { audio, boundaries }, joined into one clip. */
export async function inPieces(text, max, fn) {
  const parts = [];
  for (const piece of pieces(text, max)) parts.push(await fn(piece));
  if (!parts.length) throw new HttpError(400, 'Text is required');
  return joinPieces(parts);
}

// ---- SSML ----
export const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
/** Most C0 control characters (common in OCR'd PDFs) are rejected by the services. */
export const cleanText = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
export const hasBreaks = (text) => { BREAK_TAG.lastIndex = 0; return BREAK_TAG.test(text); };
const breakMs = (n, unit) => Math.round(parseFloat(n) * (unit.toLowerCase() === 's' ? 1000 : 1));

/**
 * Text escaped for SSML, with break tags (from the markup editor, or typed) kept as tags and
 * capped at maxMs. Nothing else in the text is read as markup.
 */
export function ssmlBody(text, { maxMs = 5000 } = {}) {
  return cleanText(text).replace(/<break\s+time="(\d+(?:\.\d+)?)\s*(ms|s)"\s*\/>|[&<>"']/gi, (m, n, unit) =>
    (n ? `<break time="${Math.min(maxMs, breakMs(n, unit))}ms"/>` : escapeXml(m)));
}

/**
 * SSML with a <mark> before every word, for providers that report when a mark is reached
 * (Google). Returns the body and the words in mark order (mark names are their indexes).
 */
export function ssmlWithMarks(text, { maxMs = 5000 } = {}) {
  const words = [];
  let body = '';
  cleanText(text).split(/(<break\s+time="\d+(?:\.\d+)?\s*(?:ms|s)"\s*\/>)/i).forEach((part, i) => {
    if (i % 2) { body += ssmlBody(part, { maxMs }); return; }
    body += part.replace(/\S+|\s+/g, (run) => {
      if (/^\s+$/.test(run)) return run;
      words.push(run);
      return `<mark name="${words.length - 1}"/>${escapeXml(run)}`;
    });
  });
  return { body, words };
}

// ---- fetch ----
/** fetch that turns network failures and timeouts into HttpErrors naming the provider (a bare throw would be a 500). */
export async function request(fetchImpl, name, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new HttpError(504, `${name} timed out`);
    throw new HttpError(502, `${name} error: ${e?.message || e}`);
  }
}

export async function readJson(res, name) {
  try {
    const data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(502, `${name} returned an unreadable response`);
  }
}

/** The error body of a failed response as an object (never a throw). */
export async function errorBody(res) {
  try { const d = await res.json(); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}

/** Which locales a provider's voice list should hold: VOICE_LOCALES (comma-separated; "*" for every one), default en-US like the Edge list. */
export function localesOf(env) {
  const raw = String(env.VOICE_LOCALES || 'en-US').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.includes('*') ? [] : raw;
}
export const localeOk = (locales, locale) => !locales.length || locales.some((l) => String(locale || '').toLowerCase() === l.toLowerCase());

export const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
