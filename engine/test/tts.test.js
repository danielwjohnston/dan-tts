// Protocol test with a fake socket: no network.
import test from 'node:test';
import assert from 'node:assert';
import { synthesize, mp3BytesToTicks } from '../src/tts.js';

function binaryFrame(path, bytes) {
  const header = new TextEncoder().encode(`X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:${path}\r\n`);
  const buf = new Uint8Array(2 + header.length + bytes.length);
  buf[0] = header.length >> 8; buf[1] = header.length & 255;
  buf.set(header, 2); buf.set(bytes, 2 + header.length);
  return buf.buffer;
}
const textFrame = (path, body) => `X-RequestId:abc\r\nContent-Type:application/json\r\nPath:${path}\r\n\r\n${body}`;

function fakeSocket(script, { open = false } = {}) {
  return (url) => {
    const ws = { readyState: open ? 1 : 0, sent: [], url, send(d) { this.sent.push(d); if (this.sent.length === 2) queueMicrotask(() => script.forEach((f) => this.onmessage({ data: f }))); }, close() {} };
    fakeSocket.last = ws;
    // Real sockets fire "open" on a later task, never synchronously
    if (!open) setTimeout(() => { ws.readyState = 1; ws.onopen(); }, 0);
    return ws;
  };
}

const meta = (text, offset, duration) => textFrame('audio.metadata', JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: offset, Duration: duration, text: { Text: text } } }] }));

test('collects audio and word boundaries until turn.end', async () => {
  const script = [textFrame('turn.start', '{}'), meta('Hello', 1000000, 4000000), binaryFrame('audio', new Uint8Array([1, 2, 3])),
    meta('&amp;world', 5125000, 1375000), binaryFrame('audio', new Uint8Array([4, 5])), textFrame('turn.end', '{}')];
  const r = await synthesize('Hello & world', { openSocket: fakeSocket(script) });
  assert.deepStrictEqual(Array.from(r.audio), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(r.boundaries.map((b) => b.text), ['Hello', '&world']);
  const [config, ssml] = fakeSocket.last.sent;
  assert.match(config, /Path:speech\.config/);
  assert.match(ssml, /<voice name='en-US-AriaNeural'>/);
  assert.match(ssml, /Hello &amp; world/);
  assert.match(fakeSocket.last.url, /Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}&Sec-MS-GEC-Version=2-/);
});

test('works with sockets that are already open (Cloudflare Workers)', async () => {
  const r = await synthesize('Hi', { openSocket: fakeSocket([binaryFrame('audio', new Uint8Array([9])), textFrame('turn.end', '{}')], { open: true }) });
  assert.deepStrictEqual(Array.from(r.audio), [9]);
});

test('rejects when no audio arrives', async () => {
  await assert.rejects(synthesize('Hi', { openSocket: fakeSocket([textFrame('turn.end', '{}')]) }), /No audio/);
});

test('strips control characters the service rejects', async () => {
  await synthesize('a\u000Bb', { openSocket: fakeSocket([binaryFrame('audio', new Uint8Array([1])), textFrame('turn.end', '{}')]) });
  assert.match(fakeSocket.last.sent[1], /a b/);
});

test('48 kbps CBR byte-to-tick conversion', () => {
  assert.strictEqual(mp3BytesToTicks(6000), 10_000_000); // 6000 bytes = 1 second
});

test('listVoices sends the token and returns the JSON list', async () => {
  let called;
  const fetchImpl = async (url, init) => { called = { url, init }; return { ok: true, json: async () => [{ ShortName: 'en-US-AriaNeural' }] }; };
  const { listVoices } = await import('../src/tts.js');
  const voices = await listVoices({ fetchImpl, headers: { Origin: 'x' } });
  assert.deepStrictEqual(voices, [{ ShortName: 'en-US-AriaNeural' }]);
  assert.match(called.url, /voices\/list\?trustedclienttoken=.*&Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}/);
  assert.deepStrictEqual(called.init, { headers: { Origin: 'x' } });
});
