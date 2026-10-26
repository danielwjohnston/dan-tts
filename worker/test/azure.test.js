// The Azure AI Speech provider, offline: fetch and the socket are replaced with canned responses.
import test from 'node:test';
import assert from 'node:assert';
import { ID_RE, PREFIX, connectionUrl, voiceListUrl, headers, refused, toHttpError, listVoices, synthesize, configured } from '../src/azure.js';

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const VOICE = 'azure:en-US-JennyNeural';

// ---- The same fake socket as the engine tests ----
function binaryFrame(path, bytes) {
  const header = new TextEncoder().encode(`X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:${path}\r\n`);
  const buf = new Uint8Array(2 + header.length + bytes.length);
  buf[0] = header.length >> 8; buf[1] = header.length & 255;
  buf.set(header, 2); buf.set(bytes, 2 + header.length);
  return buf.buffer;
}
const textFrame = (path, body) => `X-RequestId:abc\r\nContent-Type:application/json\r\nPath:${path}\r\n\r\n${body}`;
const meta = (text, offset, duration, boundaryType = 'WordBoundary') => textFrame('audio.metadata', JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: offset, Duration: duration, text: { Text: text, Length: text.length, BoundaryType: boundaryType } } }] }));
function fakeSocket(script) {
  return (url) => {
    const ws = { readyState: 1, sent: [], url, send(d) { this.sent.push(d); if (this.sent.length === 2) queueMicrotask(() => script.forEach((f) => this.onmessage({ data: f }))); }, close() {} };
    fakeSocket.last = ws;
    return ws;
  };
}

const LISTING = [
  { Name: 'Microsoft Server Speech Text to Speech Voice (en-GB, SoniaNeural)', DisplayName: 'Sonia', ShortName: 'en-GB-SoniaNeural', Gender: 'Female', Locale: 'en-GB', LocaleName: 'English (United Kingdom)', StyleList: ['cheerful', 'sad'], VoiceType: 'Neural', Status: 'GA' },
  { Name: 'Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)', DisplayName: 'Jenny', ShortName: 'en-US-JennyNeural', Gender: 'Female', Locale: 'en-US', LocaleName: 'English (United States)', StyleList: ['chat', 'newscast'], VoiceType: 'Neural', Status: 'GA' },
  { Name: 'Microsoft Server Speech Text to Speech Voice (en-US, Ava:DragonHDLatestNeural)', DisplayName: 'Ava Dragon HD Latest', ShortName: 'en-US-Ava:DragonHDLatestNeural', Gender: 'Female', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'NeuralHD', Status: 'Preview' },
  { Name: 'Microsoft Server Speech Text to Speech Voice (de-DE, KatjaNeural)', DisplayName: 'Katja', ShortName: 'de-DE-KatjaNeural', Gender: 'Female', Locale: 'de-DE', LocaleName: 'German (Germany)', VoiceType: 'Neural', Status: 'GA' },
  { Name: 'Microsoft Server Speech Text to Speech Voice (en-US, GuyNeural)', ShortName: 'en-US-GuyNeural', Gender: 'Male', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'Neural', Status: 'Deprecated' },
  { Name: 'Microsoft Server Speech Text to Speech Voice (en-US, RyanMultilingualNeural)', ShortName: 'en-US-RyanMultilingualNeural', Gender: 'Male', Locale: 'en-US', LocaleName: 'English (United States)', VoiceType: 'Neural', Status: 'GA' },
];

test('voice ids are azure:<ShortName>; HD voices and Edge ids are not', () => {
  assert.ok(ID_RE.test('azure:en-US-JennyNeural'));
  assert.ok(ID_RE.test('azure:en-GB-SoniaNeural'));
  assert.ok(ID_RE.test('azure:en-US-AvaMultilingualNeural'));
  assert.ok(!ID_RE.test('azure:'));
  assert.ok(!ID_RE.test('azure:en-US-Ava:DragonHDLatestNeural'));
  assert.ok(!ID_RE.test('azure:../x'));
  assert.ok(!ID_RE.test('en-US-AriaNeural'));
  assert.ok(!ID_RE.test('eleven:21m00Tcm4TlvDq8ikWAM'));
  assert.strictEqual(PREFIX, 'azure:');
  assert.ok(configured({ AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'eastus' }));
  assert.ok(!configured({ AZURE_SPEECH_KEY: 'k' }));
  assert.ok(!configured({ AZURE_SPEECH_REGION: 'eastus' }));
  assert.ok(!configured(undefined));
});

test('URLs use the region\'s host, a dashless GUID connection id and no Edge token; the key goes in a header', () => {
  const url = connectionUrl('eastus');
  assert.match(url, /^wss:\/\/eastus\.tts\.speech\.microsoft\.com\/cognitiveservices\/websocket\/v1\?X-ConnectionId=[0-9a-f]{32}$/);
  assert.notStrictEqual(url, connectionUrl('eastus'));
  assert.strictEqual(voiceListUrl(' WestEurope '), 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/voices/list');
  assert.deepStrictEqual(headers('secret'), { 'Ocp-Apim-Subscription-Key': 'secret' });
  for (const bad of ['', 'east us', 'eastus/..', 'eastus.evil.example', 'x']) {
    assert.throws(() => connectionUrl(bad), { status: 503, message: /AZURE_SPEECH_REGION/ });
  }
});

test('refused handshakes and failed lookups map to plain-language errors', () => {
  assert.deepStrictEqual([refused(401).status, refused(403).status], [502, 502]);
  assert.match(refused(401).message, /rejected the key or region: check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION/);
  assert.strictEqual(refused(429).status, 429);
  assert.match(refused(429).message, /rate-limiting/);
  assert.strictEqual(refused(500).status, 502);
  assert.match(refused(500).message, /HTTP 500/);
  const already = refused(429);
  assert.strictEqual(toHttpError(already), already); // an HttpError passes through unchanged
  assert.strictEqual(toHttpError(new Error('TTS timed out')).status, 504);
  assert.strictEqual(toHttpError(Object.assign(new Error('aborted'), { name: 'TimeoutError' })).status, 504);
  assert.strictEqual(toHttpError(new SyntaxError('Unexpected token <')).status, 502);
  assert.match(toHttpError(new SyntaxError('x')).message, /unreadable/);
  const other = toHttpError(new Error('WebSocket error: connection failed'));
  assert.strictEqual(other.status, 502);
  assert.match(other.message, /Azure error: WebSocket error/);
  assert.strictEqual(toHttpError('odd').status, 502);
});

test('listVoices keeps English, non-deprecated, plainly named voices in the /voices shape, en-US first', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return jsonRes(LISTING); };
  const voices = await listVoices('secret', 'eastus', { fetchImpl });
  assert.strictEqual(seen.url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
  assert.strictEqual(seen.init.headers['Ocp-Apim-Subscription-Key'], 'secret');
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.deepStrictEqual(voices.map((v) => v.shortName), ['azure:en-US-JennyNeural', 'azure:en-US-RyanMultilingualNeural', 'azure:en-GB-SoniaNeural']);
  assert.deepStrictEqual(voices[0], {
    name: 'Jenny', shortName: 'azure:en-US-JennyNeural', locale: 'en-US', localeName: 'English (United States)', gender: 'Female',
    styleList: ['chat', 'newscast'], provider: 'azure', sampleUrl: '/samples/azure:en-US-JennyNeural',
  });
  assert.strictEqual(voices[1].name, 'Ryan Multilingual'); // no DisplayName in the listing
  assert.deepStrictEqual(voices[1].styleList, []);
});

test('listVoices failures become 502/504/429, never a bare throw', async () => {
  const run = (fetchImpl) => listVoices('k', 'eastus', { fetchImpl });
  await assert.rejects(run(async () => new Response('', { status: 401 })), { status: 502, message: /rejected the key or region/ });
  await assert.rejects(run(async () => new Response('', { status: 429 })), { status: 429, message: /rate-limiting/ });
  await assert.rejects(run(async () => new Response('', { status: 500 })), { status: 502, message: /HTTP 500/ });
  await assert.rejects(run(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }), { status: 504, message: /timed out/ });
  await assert.rejects(run(async () => { throw new TypeError('fetch failed'); }), { status: 502, message: /fetch failed/ });
  await assert.rejects(run(async () => new Response('<html>busy</html>', { status: 200 })), { status: 502, message: /unreadable/ });
  await assert.rejects(run(async () => jsonRes({ voices: [] })), { status: 502, message: /unreadable voice list/ });
  await assert.rejects(listVoices('k', 'bad region', { fetchImpl: async () => { throw new Error('must not be called'); } }), { status: 503 });
  assert.deepStrictEqual(await run(async () => jsonRes([null, 'x', { Locale: 'en-US' }])), []); // odd entries are skipped, not thrown on
});

test('synthesize speaks through the engine on the Azure URL and returns audio plus word boundaries', async () => {
  const script = [textFrame('turn.start', '{}'), meta('Hello', 1000000, 4000000), binaryFrame('audio', new Uint8Array([1, 2, 3])),
    meta(',', 5000000, 500000, 'PunctuationBoundary'), meta('world', 5500000, 4000000), binaryFrame('audio', new Uint8Array([4])), textFrame('turn.end', '{}')];
  const { audio, boundaries } = await synthesize('Hello, world', VOICE, { key: 'k', region: 'eastus', openSocket: fakeSocket(script) });
  assert.deepStrictEqual([...audio], [1, 2, 3, 4]);
  assert.deepStrictEqual(boundaries, [{ offset: 1000000, duration: 4000000, text: 'Hello' }, { offset: 5500000, duration: 4000000, text: 'world' }]);
  assert.match(fakeSocket.last.url, /^wss:\/\/eastus\.tts\.speech\.microsoft\.com\/cognitiveservices\/websocket\/v1\?X-ConnectionId=[0-9a-f]{32}$/);
  const [config, ssml] = fakeSocket.last.sent;
  assert.match(config, /Path:speech\.config/);
  assert.match(config, /audio-24khz-48kbitrate-mono-mp3/);
  assert.match(ssml, /<voice name='en-US-JennyNeural'>/); // the prefix is ours, not Azure's
  assert.match(ssml, /Hello, world/);
});

test('synthesize validates before any network use: id first, then the secrets', async () => {
  const openSocket = () => { throw new Error('must not be called'); };
  await assert.rejects(synthesize('hi', 'azure:bad', { openSocket }), { status: 400 });
  await assert.rejects(synthesize('hi', VOICE, { openSocket }), { status: 503, message: /AZURE_SPEECH_KEY and AZURE_SPEECH_REGION/ });
  await assert.rejects(synthesize('hi', VOICE, { key: 'k', openSocket }), { status: 503 });
  await assert.rejects(synthesize('hi', VOICE, { region: 'eastus', openSocket }), { status: 503 });
  await assert.rejects(synthesize('hi', VOICE, { key: 'k', region: 'not a region', openSocket }), { status: 503, message: /region identifier/ });
});

test('socket failures reach the caller as HttpErrors', async () => {
  const opts = { key: 'k', region: 'eastus' };
  // The Worker's socket opener turns a refused handshake into refused(status); it passes through unchanged
  await assert.rejects(synthesize('hi', VOICE, { ...opts, openSocket: async () => { throw refused(401); } }), { status: 502, message: /rejected the key or region/ });
  await assert.rejects(synthesize('hi', VOICE, { ...opts, openSocket: async () => { throw refused(429); } }), { status: 429 });
  // Engine-level failures: no audio, a socket error, a timeout
  await assert.rejects(synthesize('hi', VOICE, { ...opts, openSocket: fakeSocket([textFrame('turn.end', '{}')]) }), { status: 502, message: /No audio/ });
  // Real sockets fail on a later task, after the engine has attached its handlers
  const erroring = () => { const ws = { readyState: 1, send() {}, close() {} }; setTimeout(() => ws.onerror({ message: 'connection reset' }), 0); return ws; };
  await assert.rejects(synthesize('hi', VOICE, { ...opts, openSocket: erroring }), { status: 502, message: /connection reset/ });
  await assert.rejects(synthesize('hi', VOICE, { ...opts, openSocket: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } }), { status: 504 });
});
