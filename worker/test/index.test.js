// The Worker's routing, offline: requests go through the same fetch handler as in production.
import test from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';

const ctx = { waitUntil() {} };
const call = (path, init) => worker.fetch(new Request(`https://dan-tts.example${path}`, init), {}, ctx);
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health and CORS', async () => {
  const res = await call('/health');
  assert.deepStrictEqual(await res.json(), { status: 'ok', runtime: 'cloudflare-worker', providers: ['edge'] });
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  assert.strictEqual((await call('/synthesize', { method: 'OPTIONS' })).status, 200);
  assert.strictEqual((await call('/nope')).status, 404);
});

test('/extract_text reads a page through the Worker', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.strictEqual(url, 'https://example.com/story');
    return new Response('<html><head><title>Story</title></head><body><nav>Menu</nav><main><p>' + 'word '.repeat(10) + '</p></main></body></html>', { headers: { 'content-type': 'text/html' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const res = await post('/extract_text', { url: 'https://example.com/story' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { text: 'word '.repeat(10).trim(), title: 'Story', chars: 49 });
});

test('/extract_text validation errors look like the Python server\'s', async () => {
  assert.deepStrictEqual([(await post('/extract_text', {})).status, (await post('/extract_text', { url: 'ftp://x' })).status, (await post('/extract_text', { url: 'http://localhost/' })).status], [400, 400, 400]);
  assert.match((await post('/extract_text', { url: 'http://localhost/' }).then((r) => r.json())).detail, /not allowed/);
  const bad = await call('/extract_text', { method: 'POST', body: 'not json' });
  assert.strictEqual(bad.status, 400);
});

test('synthesis requests are validated before any network use', async () => {
  assert.strictEqual((await post('/synthesize', { text: '' })).status, 400);
  assert.strictEqual((await post('/synthesize', { text: 'hi', voice: 'bad voice' })).status, 400);
  assert.strictEqual((await post('/synthesize', { text: 'hi', format: 'ogg' })).status, 400);
  assert.strictEqual((await post('/synthesize', { text: 'x'.repeat(20001) })).status, 422);
});

// ---- ElevenLabs provider through the routes (fetch and the cache are stubbed) ----
const ELEVEN_ENV = { ELEVENLABS_API_KEY: 'secret' };
const callWith = (env, path, init) => worker.fetch(new Request(`https://dan-tts.example${path}`, init), env, ctx);
const ELEVEN_AUDIO_B64 = Buffer.from('ID3eleven').toString('base64');
const EDGE_VOICES = [
  { Name: 'Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)', ShortName: 'en-US-AriaNeural', Locale: 'en-US', LocaleName: 'English (United States)', Gender: 'Female', StyleList: ['chat'] },
  { Name: 'Microsoft Server Speech Text to Speech Voice (de-DE, KatjaNeural)', ShortName: 'de-DE-KatjaNeural', Locale: 'de-DE', LocaleName: 'German (Germany)', Gender: 'Female' },
];

function stubNetwork(t, { elevenVoicesStatus = 200 } = {}) {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list')) return json(EDGE_VOICES);
    if (url.startsWith('https://api.elevenlabs.io/v2/voices')) {
      if (elevenVoicesStatus !== 200) return json({ detail: { status: 'invalid_api_key' } }, elevenVoicesStatus);
      return json({ voices: [{ voice_id: 'aaaaaaaaaaaa', name: 'Adam', category: 'premade', labels: { gender: 'male' }, preview_url: 'https://cdn.example/adam.mp3' }] });
    }
    if (url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) {
      assert.strictEqual(init.headers['xi-api-key'], 'secret');
      return json({ audio_base64: ELEVEN_AUDIO_B64, alignment: { characters: ['H', 'i'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.3] } });
    }
    if (url === 'https://cdn.example/adam.mp3') return new Response('ID3preview', { headers: { 'Content-Type': 'audio/mpeg' } });
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { globalThis.fetch = realFetch; globalThis.caches = realCaches; });
}

test('/health lists the ElevenLabs provider only when a key is configured', async () => {
  assert.deepStrictEqual((await callWith(ELEVEN_ENV, '/health').then((r) => r.json())).providers, ['edge', 'elevenlabs']);
  assert.deepStrictEqual((await callWith({}, '/health').then((r) => r.json())).providers, ['edge']);
});

test('/voices merges Edge (en-US only) and ElevenLabs voices with a provider field', async (t) => {
  stubNetwork(t);
  const voices = await callWith(ELEVEN_ENV, '/voices').then((r) => r.json());
  assert.deepStrictEqual(voices.map((v) => [v.shortName, v.provider, v.sampleUrl]), [
    ['en-US-AriaNeural', 'edge', '/samples/en-US-AriaNeural'],
    ['eleven:aaaaaaaaaaaa', 'elevenlabs', '/samples/eleven:aaaaaaaaaaaa'],
  ]);
  const edgeOnly = await callWith({}, '/voices').then((r) => r.json());
  assert.deepStrictEqual(edgeOnly.map((v) => v.shortName), ['en-US-AriaNeural']);
});

test('/voices still returns Edge voices when the ElevenLabs listing fails, uncached', async (t) => {
  stubNetwork(t, { elevenVoicesStatus: 401 });
  const errors = []; const realError = console.error; console.error = (m) => errors.push(m);
  t.after(() => { console.error = realError; });
  const res = await callWith(ELEVEN_ENV, '/voices');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual((await res.json()).map((v) => v.shortName), ['en-US-AriaNeural']);
  assert.match(errors.join('\n'), /rejected the API key/);
});

test('eleven: voices route to ElevenLabs for timing, export and samples', async (t) => {
  stubNetwork(t);
  const body = { text: 'Hi', voice: 'eleven:aaaaaaaaaaaa' };
  const timing = await callWith(ELEVEN_ENV, '/synthesize_with_timing', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  assert.strictEqual(timing.audio, ELEVEN_AUDIO_B64);
  assert.deepStrictEqual(timing.boundaries, [{ offset: 0, duration: 3_000_000, text: 'Hi' }]);

  const srt = await callWith(ELEVEN_ENV, '/export?format=srt', { method: 'POST', body: JSON.stringify(body) });
  assert.strictEqual(srt.status, 200);
  assert.match(await srt.text(), /00:00:00,000 --> 00:00:00,300\nHi/);

  const sample = await callWith(ELEVEN_ENV, '/samples/eleven:aaaaaaaaaaaa');
  assert.strictEqual(sample.status, 200);
  assert.strictEqual(await sample.text(), 'ID3preview');
});

test('eleven: voices are rejected clearly when no key is configured', async () => {
  const res = await post('/synthesize', { text: 'Hi', voice: 'eleven:aaaaaaaaaaaa' });
  assert.strictEqual(res.status, 503);
  assert.match((await res.json()).detail, /ELEVENLABS_API_KEY/);
  assert.strictEqual((await call('/samples/eleven:aaaaaaaaaaaa')).status, 503);
  assert.strictEqual((await post('/synthesize', { text: 'Hi', voice: 'eleven:short' })).status, 400);
});

test('/voices cache is keyed by provider set and ?refresh=1 skips the lookup', async (t) => {
  stubNetwork(t);
  const store = new Map();
  globalThis.caches = { default: { match: async (req) => store.get(req.url), put: async (req, res) => { store.set(req.url, res); } } };
  let served = await callWith({}, '/voices').then((r) => r.json());
  assert.deepStrictEqual(served.map((v) => v.provider), ['edge']);
  served = await callWith(ELEVEN_ENV, '/voices').then((r) => r.json()); // the key was added: a different cache entry
  assert.deepStrictEqual(served.map((v) => v.provider), ['edge', 'elevenlabs']);
  assert.strictEqual(store.size, 2);
  const keys = [...store.keys()];
  assert.ok(keys.some((k) => k.includes('variant=edge%2Celevenlabs')) || keys.some((k) => k.includes('variant=edge,elevenlabs')));
  await callWith(ELEVEN_ENV, '/voices?refresh=1');
  assert.strictEqual(store.size, 2, 'refresh overwrites the existing entry rather than adding one');
});

test('ElevenLabs transport errors reach the client as 502/504 through the routes', async (t) => {
  stubNetwork(t);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    return realFetch(input);
  };
  const res = await callWith(ELEVEN_ENV, '/synthesize', { method: 'POST', body: JSON.stringify({ text: 'Hi', voice: 'eleven:aaaaaaaaaaaa' }) });
  assert.strictEqual(res.status, 504);
  assert.match((await res.json()).detail, /timed out/);
});

test('ELEVENLABS_MODEL changes the model sent to ElevenLabs', async (t) => {
  stubNetwork(t);
  const realFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) body = JSON.parse(init.body);
    return realFetch(input, init);
  };
  await callWith({ ...ELEVEN_ENV, ELEVENLABS_MODEL: 'eleven_turbo_v2_5' }, '/synthesize', { method: 'POST', body: JSON.stringify({ text: 'Hi', voice: 'eleven:aaaaaaaaaaaa' }) });
  assert.strictEqual(body.model_id, 'eleven_turbo_v2_5');
});

test('/usage reports Edge as unlimited and ElevenLabs credits when configured', async (t) => {
  stubNetwork(t);
  const realFetch = globalThis.fetch;
  let subscriptionStatus = 200;
  let upstream = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.elevenlabs.io/v1/user/subscription') {
      upstream++;
      return new Response(JSON.stringify(subscriptionStatus === 200 ? { tier: 'free', character_count: 150, character_limit: 10000 } : { detail: { status: 'invalid_api_key' } }), { status: subscriptionStatus, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  // A real (Map-backed) cache, so the caching rules are exercised
  const store = new Map();
  globalThis.caches = { default: { match: async (req) => store.get(req.url), put: async (req, res) => { store.set(req.url, res); } } };
  assert.deepStrictEqual(await callWith({}, '/usage').then((r) => r.json()), { edge: { unlimited: true } });
  const withKey = await callWith(ELEVEN_ENV, '/usage').then((r) => r.json());
  assert.deepStrictEqual(withKey.elevenlabs, { provider: 'elevenlabs', tier: 'free', used: 150, limit: 10000, remaining: 9850, resetsAt: null });
  // Served from the cache: no new upstream call, whatever the query string says
  await callWith(ELEVEN_ENV, '/usage');
  await callWith(ELEVEN_ENV, '/usage?refresh=1');
  await callWith(ELEVEN_ENV, '/usage?x=2');
  assert.strictEqual(upstream, 1);
  // A failed lookup is reported (200) and kept only briefly
  store.clear();
  subscriptionStatus = 401;
  const failed = await callWith(ELEVEN_ENV, '/usage');
  assert.strictEqual(failed.status, 200);
  assert.strictEqual(failed.headers.get('cache-control'), 'public, max-age=15');
  assert.match((await failed.json()).elevenlabs.error, /rejected the API key/);
  assert.strictEqual([...store.values()][0].headers.get('cache-control'), 'public, max-age=15');
  // Concurrent cold misses share one upstream call
  store.clear();
  upstream = 0;
  subscriptionStatus = 200;
  await Promise.all([callWith(ELEVEN_ENV, '/usage'), callWith(ELEVEN_ENV, '/usage'), callWith(ELEVEN_ENV, '/usage')]);
  assert.strictEqual(upstream, 1);
});

// ---- Azure provider through the routes (fetch, the socket handshake and the cache are stubbed) ----
const AZURE_ENV = { AZURE_SPEECH_KEY: 'azure-secret', AZURE_SPEECH_REGION: 'eastus' };
const AZURE_VOICES = [
  { Name: 'Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)', DisplayName: 'Jenny', ShortName: 'en-US-JennyNeural', Gender: 'Female', Locale: 'en-US', LocaleName: 'English (United States)', StyleList: ['chat'], VoiceType: 'Neural', Status: 'GA' },
  { Name: 'Microsoft Server Speech Text to Speech Voice (de-DE, KatjaNeural)', DisplayName: 'Katja', ShortName: 'de-DE-KatjaNeural', Gender: 'Female', Locale: 'de-DE', LocaleName: 'German (Germany)', VoiceType: 'Neural', Status: 'GA' },
];

// A Workers-style socket: fetch() answers the Upgrade with { webSocket }, which the Worker accept()s
function socketResponse(script) {
  const listeners = {};
  const ws = {
    binaryType: 'blob', sent: [], accept() { ws.accepted = true; }, close() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    send(d) { ws.sent.push(d); if (ws.sent.length === 2) queueMicrotask(() => script.forEach((f) => listeners.message?.({ data: f }))); },
  };
  return { status: 101, webSocket: ws };
}
const wsText = (path, body) => `X-RequestId:abc\r\nContent-Type:application/json\r\nPath:${path}\r\n\r\n${body}`;
const wsBinary = (bytes) => {
  const header = new TextEncoder().encode('X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n');
  const buf = new Uint8Array(2 + header.length + bytes.length);
  buf[0] = header.length >> 8; buf[1] = header.length & 255;
  buf.set(header, 2); buf.set(bytes, 2 + header.length);
  return buf.buffer;
};
const wsMeta = (text, offset, duration) => wsText('audio.metadata', JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: offset, Duration: duration, text: { Text: text, Length: text.length, BoundaryType: 'WordBoundary' } } }] }));
const SPEECH = [wsText('turn.start', '{}'), wsMeta('Hi', 0, 3_000_000), wsBinary(new Uint8Array([0x49, 0x44, 0x33])), wsText('turn.end', '{}')];
const SPEECH_B64 = Buffer.from('ID3').toString('base64');

function stubAzure(t, { voicesStatus = 200, handshakeStatus = 101 } = {}) {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const seen = { handshakes: [], voiceLists: [] };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list')) return json(EDGE_VOICES);
    if (url.startsWith('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1')) {
      seen.handshakes.push({ url, headers: init.headers });
      return socketResponse(SPEECH);
    }
    if (url.startsWith('https://api.elevenlabs.io/v2/voices')) return json({ voices: [{ voice_id: 'aaaaaaaaaaaa', name: 'Adam', category: 'premade', labels: {}, preview_url: '' }] });
    if (url === 'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list') {
      seen.voiceLists.push(init.headers);
      return voicesStatus === 200 ? json(AZURE_VOICES) : new Response('', { status: voicesStatus });
    }
    if (url.startsWith('https://eastus.tts.speech.microsoft.com/cognitiveservices/websocket/v1?X-ConnectionId=')) {
      seen.handshakes.push({ url, headers: init.headers });
      return handshakeStatus === 101 ? socketResponse(SPEECH) : new Response('', { status: handshakeStatus });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { globalThis.fetch = realFetch; globalThis.caches = realCaches; });
  return seen;
}

test('/health lists azure only when both secrets are set', async () => {
  assert.deepStrictEqual((await callWith(AZURE_ENV, '/health').then((r) => r.json())).providers, ['edge', 'azure']);
  assert.deepStrictEqual((await callWith({ ...ELEVEN_ENV, ...AZURE_ENV }, '/health').then((r) => r.json())).providers, ['edge', 'elevenlabs', 'azure']);
  assert.deepStrictEqual((await callWith({ AZURE_SPEECH_KEY: 'k' }, '/health').then((r) => r.json())).providers, ['edge']);
  assert.deepStrictEqual((await callWith({ AZURE_SPEECH_REGION: 'eastus' }, '/health').then((r) => r.json())).providers, ['edge']);
});

test('/voices merges Edge, ElevenLabs and Azure (English only) voices, each with its provider', async (t) => {
  const seen = stubAzure(t);
  const voices = await callWith({ ...ELEVEN_ENV, ...AZURE_ENV }, '/voices').then((r) => r.json());
  assert.deepStrictEqual(voices.map((v) => [v.shortName, v.provider, v.sampleUrl]), [
    ['en-US-AriaNeural', 'edge', '/samples/en-US-AriaNeural'],
    ['eleven:aaaaaaaaaaaa', 'elevenlabs', '/samples/eleven:aaaaaaaaaaaa'],
    ['azure:en-US-JennyNeural', 'azure', '/samples/azure:en-US-JennyNeural'],
  ]);
  assert.deepStrictEqual(seen.voiceLists, [{ 'Ocp-Apim-Subscription-Key': 'azure-secret' }]);
  assert.deepStrictEqual(voices[2].styleList, ['chat']);
  assert.strictEqual(voices[2].name, 'Jenny');
});

test('/voices still returns the other voices when the Azure listing fails, uncached', async (t) => {
  stubAzure(t, { voicesStatus: 401 });
  const errors = []; const realError = console.error; console.error = (m) => errors.push(m);
  t.after(() => { console.error = realError; });
  const res = await callWith({ ...ELEVEN_ENV, ...AZURE_ENV }, '/voices');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual((await res.json()).map((v) => v.shortName), ['en-US-AriaNeural', 'eleven:aaaaaaaaaaaa']);
  assert.match(errors.join('\n'), /Azure voice list unavailable: Azure rejected the key or region/);
});

test('azure: voices go through the Worker socket with the key header, for timing, export and samples', async (t) => {
  const seen = stubAzure(t);
  const body = { text: 'Hi', voice: 'azure:en-US-JennyNeural' };
  const timing = await callWith(AZURE_ENV, '/synthesize_with_timing', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  assert.strictEqual(timing.audio, SPEECH_B64);
  assert.deepStrictEqual(timing.boundaries, [{ offset: 0, duration: 3_000_000, text: 'Hi' }]);
  assert.strictEqual(seen.handshakes.length, 1);
  assert.match(seen.handshakes[0].url, /^https:\/\/eastus\.tts\.speech\.microsoft\.com\/cognitiveservices\/websocket\/v1\?X-ConnectionId=[0-9a-f]{32}$/);
  assert.deepStrictEqual(seen.handshakes[0].headers, { Upgrade: 'websocket', 'Ocp-Apim-Subscription-Key': 'azure-secret' }); // no Edge headers, no token

  const srt = await callWith(AZURE_ENV, '/export?format=srt', { method: 'POST', body: JSON.stringify(body) });
  assert.strictEqual(srt.status, 200);
  assert.match(await srt.text(), /00:00:00,000 --> 00:00:00,300\nHi/);

  const sample = await callWith(AZURE_ENV, '/samples/azure:en-US-JennyNeural');
  assert.strictEqual(sample.status, 200);
  assert.strictEqual(sample.headers.get('content-type'), 'audio/mpeg');
  assert.strictEqual(await sample.text(), 'ID3');
});

test('Edge voices still open the socket with the Edge URL, token and browser headers', async (t) => {
  const seen = stubAzure(t);
  const res = await callWith(AZURE_ENV, '/synthesize', { method: 'POST', body: JSON.stringify({ text: 'Hi', voice: 'en-US-AriaNeural' }) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), 'ID3');
  assert.match(seen.handshakes[0].url, /speech\.platform\.bing\.com.*TrustedClientToken=.*Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}/);
  assert.strictEqual(seen.handshakes[0].headers.Origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
  assert.strictEqual(seen.handshakes[0].headers['Ocp-Apim-Subscription-Key'], undefined);
});

test('a refused Azure handshake is reported in plain words with the same status codes as the Python server', async (t) => {
  for (const [handshakeStatus, status, words] of [[401, 502, /rejected the key or region/], [403, 502, /AZURE_SPEECH_REGION/], [429, 429, /rate-limiting/], [500, 502, /HTTP 500/]]) {
    const errors = []; const realError = console.error; console.error = (m) => errors.push(m);
    stubAzure(t, { handshakeStatus });
    const res = await callWith(AZURE_ENV, '/synthesize', { method: 'POST', body: JSON.stringify({ text: 'Hi', voice: 'azure:en-US-JennyNeural' }) });
    console.error = realError;
    assert.strictEqual(res.status, status);
    assert.match((await res.json()).detail, words);
    assert.deepStrictEqual(errors, [], 'a provider error is not an internal error');
  }
});

test('azure: voices are rejected clearly when the secrets are missing', async () => {
  const res = await post('/synthesize', { text: 'Hi', voice: 'azure:en-US-JennyNeural' });
  assert.strictEqual(res.status, 503);
  assert.match((await res.json()).detail, /AZURE_SPEECH_KEY and AZURE_SPEECH_REGION/);
  assert.strictEqual((await callWith({ AZURE_SPEECH_KEY: 'k' }, '/synthesize', { method: 'POST', body: JSON.stringify({ text: 'Hi', voice: 'azure:en-US-JennyNeural' }) })).status, 503);
  assert.strictEqual((await call('/samples/azure:en-US-JennyNeural')).status, 503);
  assert.strictEqual((await post('/synthesize', { text: 'Hi', voice: 'azure:en-US-Ava:DragonHDLatestNeural' })).status, 400);
  assert.strictEqual((await call('/samples/azure:bad')).status, 400);
});

test('/usage carries the Azure note when configured; Azure has no usage endpoint', async (t) => {
  stubAzure(t);
  assert.deepStrictEqual(await callWith(AZURE_ENV, '/usage').then((r) => r.json()), {
    edge: { unlimited: true },
    azure: { tracked: false, note: 'Azure reports usage in its portal; the free tier is 500,000 characters a month' },
  });
  assert.deepStrictEqual(await callWith({}, '/usage').then((r) => r.json()), { edge: { unlimited: true } });
});
