// Test fixtures shared by the provider tests.

/** n silent frames of MPEG-2 Layer III, 24 kHz, 48 kbps: 144 bytes and 24 ms (240,000 ticks) each. */
export function mp3(n, { id3 = false, tag = false } = {}) {
  const frames = [];
  for (let i = 0; i < n; i++) { const f = new Uint8Array(144); f.set([0xff, 0xf3, 0x64, 0xc0]); f[4] = i; frames.push(f); }
  const parts = [];
  if (id3) parts.push(Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20, ...new Array(20).fill(7)])); // "ID3", 20-byte body
  parts.push(...frames);
  if (tag) parts.push(Uint8Array.from([0x54, 0x41, 0x47, ...new Array(125).fill(1)]));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
