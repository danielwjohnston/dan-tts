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

// ---- Speechify provider through the routes (fetch and the cache are stubbed) ----
const SPEECHIFY_ENV = { SPEECHIFY_API_KEY: 'sk_test' };
const SPEECHIFY_AUDIO_B64 = Buffer.from('ID3speechify').toString('base64');
const SPEECHIFY_MARKS = { chunks: [{ value: 'Hi', start_time: 0, end_time: 200 }] };

function stubSpeechify(t, { voicesStatus = 200 } = {}) {
  const realFetch = globalThis.fetch;
  const realCaches = globalThis.caches;
  const seen = [];
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
    seen.push({ url, init });
    if (url.startsWith('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list')) return json(EDGE_VOICES);
    if (url.startsWith('https://api.speechify.ai/v1/voices?')) {
      assert.strictEqual(init.headers.Authorization, 'Bearer sk_test');
      if (voicesStatus !== 200) return json({ error: { code: 'unauthorized', message: 'bad key' } }, voicesStatus);
      return json({ voices: [{ id: 'geffen_32', display_name: 'Geffen', type: 'shared', gender: 'male', locale: 'en-US', models: [], preview_audio: 'https://cdn.example/geffen.mp3' }], has_more: false });
    }
    if (url === 'https://api.speechify.ai/v1/audio/speech') {
      assert.strictEqual(init.headers.Authorization, 'Bearer sk_test');
      return json({ audio_data: SPEECHIFY_AUDIO_B64, audio_format: 'mp3', billable_characters_count: 2, speech_marks: SPEECHIFY_MARKS });
    }
    if (url === 'https://api.speechify.ai/v1/audio/stream') return new Response('ID3stream', { headers: { 'Content-Type': 'audio/mpeg' } });
    if (url === 'https://cdn.example/geffen.mp3') return new Response('ID3preview', { headers: { 'Content-Type': 'audio/mpeg' } });
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => { globalThis.fetch = realFetch; globalThis.caches = realCaches; });
  return seen;
}

test('/health lists the Speechify provider only when a key is configured', async () => {
  assert.deepStrictEqual((await callWith(SPEECHIFY_ENV, '/health').then((r) => r.json())).providers, ['edge', 'speechify']);
  assert.deepStrictEqual((await callWith({ ...ELEVEN_ENV, ...SPEECHIFY_ENV }, '/health').then((r) => r.json())).providers, ['edge', 'elevenlabs', 'speechify']);
});

test('/voices merges Speechify voices, filtered by the configured model, with a provider field', async (t) => {
  const seen = stubSpeechify(t);
  const served = await callWith({ ...SPEECHIFY_ENV, SPEECHIFY_MODEL: 'simba-3.2' }, '/voices').then((r) => r.json());
  assert.deepStrictEqual(served.map((v) => [v.shortName, v.provider, v.sampleUrl]), [
    ['en-US-AriaNeural', 'edge', '/samples/en-US-AriaNeural'],
    ['speechify:geffen_32', 'speechify', '/samples/speechify:geffen_32'],
  ]);
  assert.ok(seen.some((s) => s.url.includes('/v1/voices?limit=200&model=simba-3.2')));
});

test('/voices still returns Edge voices when the Speechify listing fails, uncached', async (t) => {
  stubSpeechify(t, { voicesStatus: 401 });
  const res = await callWith(SPEECHIFY_ENV, '/voices');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.deepStrictEqual((await res.json()).map((v) => v.provider), ['edge']);
});

test('speechify: voices use the speech endpoint for timings and export, the stream endpoint for plain audio, and the preview for samples', async (t) => {
  const seen = stubSpeechify(t);
  const body = { text: 'Hi', voice: 'speechify:geffen_32' };
  const timing = await callWith(SPEECHIFY_ENV, '/synthesize_with_timing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  assert.strictEqual(Buffer.from(timing.audio, 'base64').toString(), 'ID3speechify');
  assert.deepStrictEqual(timing.boundaries, [{ offset: 0, duration: 2_000_000, text: 'Hi' }]);
  const sent = JSON.parse(seen.find((s) => s.url.endsWith('/v1/audio/speech')).init.body);
  assert.deepStrictEqual(sent, { input: 'Hi', voice_id: 'geffen_32', model: 'simba-3.5', audio_format: 'mp3' });
  const exported = await callWith(SPEECHIFY_ENV, '/export?format=srt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.match(await exported.text(), /00:00:00,000 --> 00:00:00,200\nHi/);
  const plain = await callWith(SPEECHIFY_ENV, '/synthesize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual(await plain.text(), 'ID3stream');
  assert.strictEqual(plain.headers.get('content-type'), 'audio/mpeg');
  const sample = await callWith(SPEECHIFY_ENV, '/samples/speechify:geffen_32');
  assert.strictEqual(await sample.text(), 'ID3preview');
});

test('SPEECHIFY_MODEL, SPEECHIFY_LANGUAGE and SPEECHIFY_API_URL reach the Speechify request', async (t) => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (input, init) => {
    seen = { url: typeof input === 'string' ? input : input.url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ audio_data: SPEECHIFY_AUDIO_B64, speech_marks: SPEECHIFY_MARKS }), { headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  await callWith({ ...SPEECHIFY_ENV, SPEECHIFY_MODEL: 'simba-3.2', SPEECHIFY_LANGUAGE: 'fr-FR', SPEECHIFY_API_URL: 'https://eu.api.speechify.ai' }, '/synthesize_with_timing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Salut', voice: 'speechify:geffen_32' }) });
  assert.strictEqual(seen.url, 'https://eu.api.speechify.ai/v1/audio/speech');
  assert.deepStrictEqual(seen.body, { input: 'Salut', voice_id: 'geffen_32', model: 'simba-3.2', audio_format: 'mp3', language: 'fr-FR' });
});

test('speechify: voices are rejected clearly when no key is configured', async () => {
  const res = await post('/synthesize', { text: 'Hi', voice: 'speechify:geffen_32' });
  assert.strictEqual(res.status, 503);
  assert.match((await res.json()).detail, /SPEECHIFY_API_KEY/);
  assert.strictEqual((await call('/samples/speechify:geffen_32')).status, 503);
  assert.strictEqual((await post('/synthesize', { text: 'Hi', voice: 'speechify:bad id' })).status, 400);
  assert.strictEqual((await callWith(SPEECHIFY_ENV, '/synthesize_with_timing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(2001), voice: 'speechify:geffen_32' }) })).status, 422);
});
