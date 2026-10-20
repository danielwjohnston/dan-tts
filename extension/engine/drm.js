// Sec-MS-GEC v2 token for Microsoft Edge's read-aloud TTS service.
// Port of edge-tts' drm.py (rany2/edge-tts, v7.3.x); verified against its output in
// test/drm.test.js. If Microsoft changes the scheme, update both together.

export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

const WIN_EPOCH = 11644473600;

const SHA256_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const SHA256_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const SHA256_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0,
  0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const K = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const K_BLOCK = [...K.slice(0, 14), SHA256_ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJUSTMENT = 0x059C0B80;
const SIGMA1_ADJUSTMENT = 0x000B92C0;

const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xF2F90B1A;
const CS64_ADJUSTMENT1 = 0x0B1A0000;

const u32 = (x) => x >>> 0;
const mul = (a, b) => Math.imul(a, b) >>> 0;
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const rol16 = (x) => ((x << 16) | (x >>> 16)) >>> 0;
const sigma0 = (x) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const sigma1 = (x) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;

function rounds(state, w, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = firstRound === 14 ? K_BLOCK : K;
  for (let i = firstRound; i < 64; i++) {
    const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((g ^ (e & (f ^ g))) >>> 0) + k[i] + w[i];
    const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (((a & b) | (c & (a | b))) >>> 0);
    h = g; g = f; f = e; e = u32(d + t1); d = c; c = b; b = a; a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(w, first = 16) {
  for (let i = first; i < 64; i++) {
    w.push(u32(sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]));
  }
}

const be32 = (bytes, off, len = 4) => {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + bytes[off + i];
  return v >>> 0;
};

function sha256Init(data7) {
  const w = new Array(14).fill(0);
  w.push(be32(data7, 0, 3));
  w.push(be32(data7, 3, 4));
  for (let i = 16; i < 30; i++) {
    let v = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? (sigma1(w[i - 2]) ^ SIGMA1_ADJUSTMENT) >>> 0 : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? (sigma0(w[i - 15]) ^ SIGMA0_ADJUSTMENT) >>> 0 : sigma0(w[i - 15]);
    w.push(u32(v));
  }
  w.push(u32(sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - K[14]));
  expandSchedule(w, 31);
  const working = rounds(SHA256_STATE, w, 14);
  return SHA256_INITIAL.map((x, i) => u32(x + working[i]));
}

function sha256Digest(data) {
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + zeros + 8);
  padded.set(data.subarray(7), 0);
  padded[data.length - 7] = 0x80;
  const bits = BigInt(length * 8);
  for (let i = 0; i < 8; i++) padded[padded.length - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xFFn);
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w.push(be32(padded, off + i * 4));
    expandSchedule(w);
    const working = rounds(state, w);
    state = state.map((x, i) => u32(x + working[i]));
  }
  const out = new Uint8Array(32);
  state.forEach((x, i) => { out[i * 4] = x >>> 24; out[i * 4 + 1] = (x >>> 16) & 255; out[i * 4 + 2] = (x >>> 8) & 255; out[i * 4 + 3] = x & 255; });
  return out;
}

function wordsLE4Even(bytes) {
  const len = bytes.length + ((4 - (bytes.length % 4)) % 4);
  const words = [];
  for (let i = 0; i < len; i += 4) {
    words.push(((bytes[i] || 0) | ((bytes[i + 1] || 0) << 8) | ((bytes[i + 2] || 0) << 16) | ((bytes[i + 3] || 0) << 24)) >>> 0);
  }
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  const le32 = (o) => (digest[o] | (digest[o + 1] << 8) | (digest[o + 2] << 16) | (digest[o + 3] << 24)) >>> 0;
  const keyA = (le32(0) | 1) >>> 0;
  const keyB = (le32(4) | 1) >>> 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => mul(coef, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, off]) => off);
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  wordsLE4Even(prefixed).forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) {
      term = u32(term + mul(CS64_ADJUSTMENT0, factors[0]));
      offset = u32(offset + CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16(u32(offsets[i] + x));
    let q = mul(t, 0x76F50F34);
    swapAcc = u32(swapAcc + u32(mul(rol16(q), 0xC3EFEA97) + q));
    t = rol16(u32(offsets[i + 1] + y));
    q = mul(t, 0x1881CE3C);
    swapLast = u32(mul(rol16(q), 0x35BD1EC9) + q);
    swapAcc = u32(swapAcc + swapLast);

    state = u32(mul(state, keyA) + x);
    state = mul(rol16(state), 0xCF98B111);
    state = mul(rol16(state), 0x87085B9F);
    state = mul(rol16(state), 0x12CEB96D);
    state = mul(rol16(state), 0x257E1D83);
    acc = u32(acc + state);
    t = u32(mul(state, keyB) + y);
    t = mul(rol16(t), 0xA27416F5);
    t = mul(rol16(t), 0xD38396FF);
    state = mul(rol16(mul(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = u32(acc + state);
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const le32hex = (x) => hex([x & 255, (x >>> 8) & 255, (x >>> 16) & 255, x >>> 24]);

/** Sec-MS-GEC token for a Unix timestamp in seconds (defaults to now). */
export function generateSecMsGec(unixSeconds = Date.now() / 1000) {
  let ticks = unixSeconds + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  const input = new TextEncoder().encode(`${BigInt(Math.round(ticks))}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256Digest(input);
  const [c0, c1] = cs64Digest(input, digest);
  return `${le32hex(c0)}${le32hex(c1)}-${hex(digest)}`;
}
