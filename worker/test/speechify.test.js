// The Speechify provider, offline: fetch is replaced with canned responses.
import test from 'node:test';
import assert from 'node:assert';
import { speechMarksToBoundaries, listVoices, synthesize, sample, usage, ID_RE, MAX_CHARS, STREAM_MAX_CHARS, DEFAULT_MODEL, USAGE_URL } from '../src/speechify.js';

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const AUDIO = Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3]); // "ID3" + bytes
const AUDIO_B64 = Buffer.from(AUDIO).toString('base64');
const VOICE = 'speechify:geffen_32';

// "Hello, welcome" spoken over 0.125s-0.75s, in Speechify's milliseconds
const MARKS = {
  type: 'sentence', value: 'Hello, welcome', start: 0, end: 14, start_time: 0, end_time: 750,
  chunks: [
    { type: 'word', value: 'Hello,', start: 0, end: 6, start_time: 125, end_time: 375 },
    { type: 'word', value: 'welcome', start: 7, end: 14, start_time: 375, end_time: 750.4 },
  ],
};

test('voice ids are speechify:<id>', () => {
  assert.ok(ID_RE.test('speechify:geffen_32'));
  assert.ok(ID_RE.test('speechify:1f3c9a2e-7b4d-4c3e-9a1b-2c3d4e5f6a7b'));
  assert.ok(!ID_RE.test('speechify:'));
  assert.ok(!ID_RE.test('speechify:../x'));
  assert.ok(!ID_RE.test('speechify:bad id'));
  assert.ok(!ID_RE.test('eleven:geffen_32'));
  assert.ok(!ID_RE.test('en-US-AriaNeural'));
});

test('speech marks (ms) become word boundaries in 100 ns ticks, same as the Python server', () => {
  assert.deepStrictEqual(speechMarksToBoundaries(MARKS), [
    { offset: 1_250_000, duration: 2_500_000, text: 'Hello,' },
    { offset: 3_750_000, duration: 3_754_000, text: 'welcome' },
  ]);
  assert.deepStrictEqual(speechMarksToBoundaries(undefined), []);
  assert.deepStrictEqual(speechMarksToBoundaries({ chunks: [] }), []);
  assert.deepStrictEqual(speechMarksToBoundaries({ value: 'Hi', start_time: '10', end_time: null }), [{ offset: 100_000, duration: 0, text: 'Hi' }]);
  const nested = { chunks: [{ chunks: [{ value: 'a', start_time: 0, end_time: 100 }, { value: ' ', start_time: 100, end_time: 100 }] }, { value: 'b', start_time: 200, end_time: 300 }] };
  assert.deepStrictEqual(speechMarksToBoundaries(nested).map((b) => b.text), ['a', 'b']);
});

test('listVoices follows cursors, filters to the model and returns the /voices shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (url.includes('cursor=c2')) {
      return jsonRes({ voices: [{ id: 'no_models', display_name: 'Plain', type: 'shared', gender: 'female', locale: 'en-AU', models: [] }], next_cursor: null, has_more: false });
    }
    return jsonRes({
      voices: [
        { id: 'geffen_32', display_name: 'Geffen', type: 'shared', gender: 'male', locale: 'en-US', tags: ['narration', 'calm', 'deep', 'extra'],
          models: [{ name: 'simba-3.5', languages: [{ locale: 'en-US', preview_audio: 'https://cdn.example/geffen-en.mp3' }] }], preview_audio: 'https://cdn.example/geffen.mp3' },
        { id: 'old_only', display_name: 'Old', type: 'shared', gender: 'female', locale: 'en-GB', models: [{ name: 'simba-english', languages: [] }] },
        { id: 'bad id', display_name: 'Bad', models: [] },
        { id: 'my-clone', display_name: '', type: 'personal', gender: 'not_specified', locale: 'en-US',
          models: [{ name: 'simba-3.5', languages: [{ locale: 'fr-FR', preview_audio: 'https://cdn.example/clone-fr.mp3' }, { locale: 'en-US', preview_audio: 'https://cdn.example/clone-en.mp3' }] }] },
      ],
      next_cursor: 'c2', has_more: true,
    });
  };
  const voices = await listVoices('secret', { fetchImpl });
  assert.deepStrictEqual(calls.map((c) => c.url), ['https://api.speechify.ai/v1/voices?limit=200&locale=en', 'https://api.speechify.ai/v1/voices?limit=200&locale=en&cursor=c2']);
  assert.ok(calls.every((c) => c.auth === 'Bearer secret'));
  assert.deepStrictEqual(voices[0], {
    name: 'Geffen', shortName: 'speechify:geffen_32', locale: 'en-US', localeName: 'en-US · Narration · Calm · Deep', gender: 'Male',
    styleList: [], provider: 'speechify', category: 'shared', previewUrl: 'https://cdn.example/geffen.mp3', sampleUrl: '/samples/speechify:geffen_32',
  });
  assert.deepStrictEqual(voices.map((v) => v.shortName), ['speechify:geffen_32', 'speechify:my-clone', 'speechify:no_models']);
  assert.deepStrictEqual([voices[1].name, voices[1].gender, voices[1].previewUrl], ['my-clone', '', 'https://cdn.example/clone-en.mp3']);
  assert.strictEqual(voices[2].previewUrl, '');
  // a different model keeps a different set; an empty locale lists everything
  const all = await listVoices('secret', { fetchImpl, model: 'simba-english', locale: '' });
  assert.deepStrictEqual(all.map((v) => v.shortName), ['speechify:old_only', 'speechify:no_models']);
  assert.ok(calls[calls.length - 1].url.endsWith('cursor=c2'));
  assert.ok(!calls[calls.length - 2].url.includes('locale='));
});

test('synthesize with timings posts to /v1/audio/speech and decodes audio plus boundaries', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return jsonRes({ audio_data: AUDIO_B64, audio_format: 'mp3', billable_characters_count: 14, speech_marks: MARKS }); };
  const { audio, boundaries } = await synthesize('Hello, welcome', VOICE, { key: 'secret', fetchImpl });
  assert.strictEqual(seen.url, 'https://api.speechify.ai/v1/audio/speech');
  assert.strictEqual(seen.init.method, 'POST');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer secret');
  assert.strictEqual(seen.init.headers.Accept, 'application/json');
  assert.deepStrictEqual(JSON.parse(seen.init.body), { input: 'Hello, welcome', voice_id: 'geffen_32', model: DEFAULT_MODEL, audio_format: 'mp3' });
  assert.deepStrictEqual([...audio], [...AUDIO]);
  assert.deepStrictEqual(boundaries.map((b) => b.text), ['Hello,', 'welcome']);
  // language and a configured model ride along
  await synthesize('Bonjour', VOICE, { key: 'secret', model: 'simba-3.2', language: 'fr-FR', fetchImpl });
  assert.deepStrictEqual(JSON.parse(seen.init.body), { input: 'Bonjour', voice_id: 'geffen_32', model: 'simba-3.2', audio_format: 'mp3', language: 'fr-FR' });
});

test('synthesize without timings streams the audio bytes from /v1/audio/stream', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(AUDIO, { headers: { 'Content-Type': 'audio/mpeg' } }); };
  const long = 'x'.repeat(MAX_CHARS + 1); // too long for the speech endpoint, fine for the stream
  const { audio, boundaries } = await synthesize(long, VOICE, { key: 'secret', timings: false, fetchImpl });
  assert.strictEqual(seen.url, 'https://api.speechify.ai/v1/audio/stream');
  assert.strictEqual(seen.init.headers.Accept, 'audio/mpeg');
  assert.strictEqual(JSON.parse(seen.init.body).input, long);
  assert.deepStrictEqual([...audio], [...AUDIO]);
  assert.deepStrictEqual(boundaries, []);
  await assert.rejects(synthesize('hi', VOICE, { key: 'k', timings: false, fetchImpl: async () => new Response(new Uint8Array(0)) }), { status: 502, message: /no audio/ });
});

test('synthesize validates before any network use', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  await assert.rejects(synthesize('hi', 'speechify:bad id', { fetchImpl }), { status: 400 }); // id first, then key
  await assert.rejects(synthesize('hi', VOICE, { fetchImpl }), { status: 503, message: /SPEECHIFY_API_KEY/ });
  await assert.rejects(synthesize('x'.repeat(MAX_CHARS + 1), VOICE, { key: 'k', fetchImpl }), { status: 422, message: /word timings/ });
  await assert.rejects(synthesize('x'.repeat(STREAM_MAX_CHARS + 1), VOICE, { key: 'k', timings: false, fetchImpl }), { status: 422 });
  // SSML tags are not spoken characters
  const ssml = `<speak>${'x'.repeat(1990)} <break time="0.4s" /> yyyyy</speak>`;
  assert.ok(ssml.length > MAX_CHARS);
  const ok = async () => jsonRes({ audio_data: AUDIO_B64, speech_marks: {} });
  assert.deepStrictEqual((await synthesize(ssml, VOICE, { key: 'k', fetchImpl: ok })).boundaries, []);
});

test('Speechify failures map to plain-language errors', async () => {
  const run = (status, body, opts = {}) => synthesize('hi', VOICE, { key: 'k', fetchImpl: async () => jsonRes(body, status), ...opts });
  await assert.rejects(run(401, { error: { code: 'unauthorized', message: 'bad key' } }), { status: 502, message: /rejected the API key \(bad key\)/ });
  await assert.rejects(run(402, { error: { code: 'insufficient_credits' } }), { status: 429, message: /credits are used up/ });
  await assert.rejects(run(400, { error: { code: 'model_retired', message: 'retired' } }, { model: 'simba-english' }), { status: 502, message: /simba-english is retired: set SPEECHIFY_MODEL/ });
  await assert.rejects(run(400, { error: { code: 'content_policy_violation' } }), { status: 422, message: /content policy/ });
  await assert.rejects(run(400, { error: { code: 'validation_failed', message: 'input too long' } }), { status: 422, message: /rejected the request \(input too long\)/ });
  await assert.rejects(run(429, { error: { code: 'rate_limited' } }), { status: 429, message: /rate-limiting/ });
  await assert.rejects(synthesize('hi', VOICE, { key: 'k', fetchImpl: async () => new Response('Bad gateway', { status: 500 }) }), { status: 502, message: /HTTP 500/ });
  await assert.rejects(run(200, { speech_marks: MARKS }), { status: 502, message: /no audio/ });
  await assert.rejects(run(200, { audio_data: '%%%not base64%%%' }), { status: 502, message: /unreadable audio/ });
  await assert.rejects(synthesize('hi', VOICE, { key: 'k', fetchImpl: async () => new Response('<html>busy</html>', { status: 200 }) }), { status: 502, message: /unreadable response/ });
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  await assert.rejects(synthesize('hi', VOICE, { key: 'k', fetchImpl: async () => { throw timeout; } }), { status: 504, message: /timed out/ });
  await assert.rejects(synthesize('hi', VOICE, { key: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { status: 502, message: /fetch failed/ });
  await assert.rejects(listVoices('k', { fetchImpl: async () => new Response('null', { status: 200 }) }), { status: 502 });
});

test('sample serves the preview clip and 404s for unknown voices', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.speechify.ai/v1/voices')) {
      return jsonRes({ voices: [
        { id: 'geffen_32', display_name: 'Geffen', preview_audio: 'https://cdn.example/geffen.mp3' },
        { id: 'quiet', display_name: 'Quiet', preview_audio: null },
      ], next_cursor: null, has_more: false });
    }
    if (url === 'https://cdn.example/geffen.mp3') return new Response(AUDIO, { headers: { 'Content-Type': 'application/octet-stream' } });
    throw new Error(`unexpected ${url}`);
  };
  const { audio, contentType } = await sample('k', VOICE, { fetchImpl });
  assert.deepStrictEqual([...audio], [...AUDIO]);
  assert.strictEqual(contentType, 'audio/mpeg');
  await assert.rejects(sample('k', 'speechify:nope', { fetchImpl }), { status: 404 });
  await assert.rejects(sample('k', 'speechify:quiet', { fetchImpl }), { status: 404, message: /no preview/ });
});

test('usage points at the console: Speechify has no usage endpoint', () => {
  assert.deepStrictEqual(usage(), { provider: 'speechify', unlimited: false, usageUrl: USAGE_URL });
});
