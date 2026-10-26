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

const meta = (text, offset, duration, boundaryType) => textFrame('audio.metadata', JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: offset, Duration: duration, text: boundaryType ? { Text: text, Length: text.length, BoundaryType: boundaryType } : { Text: text } } }] }));

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

test('a socket that errors again when closed rejects once, with the first error', async () => {
  let closes = 0;
  const openSocket = () => {
    const ws = { readyState: 0, send() {}, close() { closes++; ws.onerror?.({ message: 'closed before established' }); ws.onclose?.({ code: 1006 }); } };
    setTimeout(() => ws.onerror({ message: 'handshake refused' }), 0);
    return ws;
  };
  await assert.rejects(synthesize('Hi', { openSocket }), /handshake refused/);
  assert.strictEqual(closes, 1);
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

// ---- Azure AI Speech: the same protocol on another URL, with a key header instead of the Edge token ----

const AZURE_URL = 'wss://eastus.tts.speech.microsoft.com/cognitiveservices/websocket/v1?X-ConnectionId=0123456789abcdef0123456789abcdef';

test('connectionUrl replaces the Edge URL and gets no Sec-MS-GEC token', async () => {
  const script = [meta('Hello', 1000000, 4000000, 'WordBoundary'), binaryFrame('audio', new Uint8Array([7])), textFrame('turn.end', '{}')];
  const r = await synthesize('Hello', { voice: 'en-US-JennyNeural', openSocket: fakeSocket(script, { open: true }), connectionUrl: AZURE_URL });
  assert.strictEqual(fakeSocket.last.url, AZURE_URL);
  assert.ok(!/Sec-MS-GEC|TrustedClientToken/.test(fakeSocket.last.url));
  assert.match(fakeSocket.last.sent[1], /<voice name='en-US-JennyNeural'>/);
  assert.deepStrictEqual(Array.from(r.audio), [7]);
  assert.deepStrictEqual(r.boundaries, [{ offset: 1000000, duration: 4000000, text: 'Hello' }]);
});

test('punctuation boundaries (Azure) are skipped; Edge-style entries without a type are kept', async () => {
  const script = [meta('Hello', 0, 4000000, 'WordBoundary'), meta(',', 4000000, 500000, 'PunctuationBoundary'), meta('world', 5000000, 4000000),
    binaryFrame('audio', new Uint8Array([1])), textFrame('turn.end', '{}')];
  const r = await synthesize('Hello, world', { openSocket: fakeSocket(script) });
  assert.deepStrictEqual(r.boundaries.map((b) => b.text), ['Hello', 'world']);
});

test('listVoices fetches voiceListUrl as given, with the caller\'s headers and no token', async () => {
  let called;
  const fetchImpl = async (url, init) => { called = { url, init }; return { ok: true, json: async () => [{ ShortName: 'en-US-JennyNeural' }] }; };
  const { listVoices } = await import('../src/tts.js');
  const url = 'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list';
  const voices = await listVoices({ fetchImpl, headers: { 'Ocp-Apim-Subscription-Key': 'k' }, voiceListUrl: url });
  assert.deepStrictEqual(voices, [{ ShortName: 'en-US-JennyNeural' }]);
  assert.strictEqual(called.url, url);
  assert.deepStrictEqual(called.init, { headers: { 'Ocp-Apim-Subscription-Key': 'k' } });
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
