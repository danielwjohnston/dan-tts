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
