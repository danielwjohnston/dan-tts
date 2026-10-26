// The Speechify provider, offline: fetch is replaced with canned responses.
import test from 'node:test';
import assert from 'node:assert';
import { marksToBoundaries, listVoices, synthesize, stream, sample, toInput, ID_RE, MAX_CHARS, MAX_STREAM_CHARS, DEFAULT_MODEL } from '../src/speechify.js';

const jsonRes = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const AUDIO = Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3]); // "ID3" + bytes
const AUDIO_B64 = Buffer.from(AUDIO).toString('base64');

// "Hi there" spoken over 0-950 ms, nested the way Speechify returns it
const MARKS = {
  type: 'sentence', start: 0, end: 8, start_time: 0, end_time: 950, value: 'Hi there',
  chunks: [
    { type: 'word', start: 0, end: 2, start_time: 0, end_time: 200, value: 'Hi' },
    { type: 'word', start: 3, end: 8, start_time: 300, end_time: 950, value: 'there' },
  ],
};
const VOICE = { id: 'geffen_32', display_name: 'Geffen', type: 'shared', gender: 'male', locale: 'en-US', tags: ['timbre:deep'], preview_audio: 'https://cdn.example/geffen.mp3', models: [{ name: 'simba-3.5', languages: [{ locale: 'en-US', preview_audio: 'https://cdn.example/geffen-en.mp3' }] }] };

test('voice ids are speechify:<id>', () => {
  assert.ok(ID_RE.test('speechify:geffen_32'));
  assert.ok(ID_RE.test('speechify:9f2d8c1e-0b4a-4b2e-8b1a-1234567890ab'));
  assert.ok(!ID_RE.test('speechify:'));
  assert.ok(!ID_RE.test('speechify:../x'));
  assert.ok(!ID_RE.test('eleven:geffen_32'));
  assert.ok(!ID_RE.test('en-US-AriaNeural'));
});

test('speech marks become word boundaries in 100 ns ticks, however deeply nested', () => {
  assert.deepStrictEqual(marksToBoundaries(MARKS), [
    { offset: 0, duration: 2_000_000, text: 'Hi' },
    { offset: 3_000_000, duration: 6_500_000, text: 'there' },
  ]);
  // A streaming shape (an array of mark objects) and a flat one both work; blanks and junk are skipped
  assert.deepStrictEqual(marksToBoundaries([MARKS, { chunks: [{ value: ' ', start_time: 1, end_time: 2 }] }]).length, 2);
  assert.deepStrictEqual(marksToBoundaries({ value: 'Solo', start_time: 12.5, end_time: 100 }), [{ offset: 125_000, duration: 875_000, text: 'Solo' }]);
  assert.deepStrictEqual(marksToBoundaries(undefined), []);
  assert.deepStrictEqual(marksToBoundaries({ chunks: [] }), []);
  assert.deepStrictEqual(marksToBoundaries({ chunks: [{ value: 'x', start_time: 'bad', end_time: null }] }), [{ offset: 0, duration: 0, text: 'x' }]);
});

test('toInput wraps text in <speak> and escapes it only when markup tags are present', () => {
  assert.strictEqual(toInput('Tom & Jerry <3'), 'Tom & Jerry <3');
  assert.strictEqual(toInput('Wait <break time="800ms"/> here & there'), '<speak>Wait <break time="800ms"/> here &amp; there</speak>');
  assert.strictEqual(toInput('the <sub alias="Ker-nel">kernel</sub> panicked'), '<speak>the <sub alias="Ker-nel">kernel</sub> panicked</speak>');
  // Other angle brackets, including hand-written SSML, are spoken as written
  assert.strictEqual(toInput('<prosody rate="slow">x</prosody> <break time="400ms" />'), '<speak>&lt;prosody rate=&quot;slow&quot;&gt;x&lt;/prosody&gt; <break time="400ms" /></speak>');
});

test('listVoices follows cursors, filters by model and returns the /voices shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (url.includes('cursor=c2')) return jsonRes({ voices: [{ id: 'henry', display_name: 'Henry', type: 'personal', gender: 'not_specified', locale: 'en-GB', models: [] }], next_cursor: null, has_more: false });
    return jsonRes({ voices: [VOICE, { display_name: 'no id' }], next_cursor: 'c2', has_more: true });
  };
  const voices = await listVoices('sk_test', { fetchImpl });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].url.startsWith('https://api.speechify.ai/v1/voices?limit=200&model=simba-3.5'));
  assert.ok(calls[1].url.includes('cursor=c2'));
  assert.deepStrictEqual(calls.map((c) => c.auth), ['Bearer sk_test', 'Bearer sk_test']);
  assert.deepStrictEqual(voices, [
    { name: 'Geffen', shortName: 'speechify:geffen_32', locale: 'en-US', localeName: 'en-US · timbre:deep', gender: 'Male', styleList: [], provider: 'speechify', category: 'shared', previewUrl: 'https://cdn.example/geffen.mp3', sampleUrl: '/samples/speechify:geffen_32' },
    { name: 'Henry', shortName: 'speechify:henry', locale: 'en-GB', localeName: 'en-GB', gender: '', styleList: [], provider: 'speechify', category: 'personal', previewUrl: '', sampleUrl: '/samples/speechify:henry' },
  ]);
  const custom = await listVoices('sk_test', { model: 'simba-3.2', api: 'https://eu.api.speechify.ai/', fetchImpl: async (url) => { assert.ok(url.startsWith('https://eu.api.speechify.ai/v1/voices?limit=200&model=simba-3.2')); return jsonRes({ voices: [], has_more: false }); } });
  assert.deepStrictEqual(custom, []);
});

test('synthesize posts the Speechify request shape and returns audio with boundaries', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonRes({ audio_data: AUDIO_B64, audio_format: 'mp3', billable_characters_count: 8, speech_marks: MARKS });
  };
  const r = await synthesize('Hi there', 'speechify:geffen_32', { key: 'sk_test', fetchImpl });
  assert.strictEqual(seen.url, 'https://api.speechify.ai/v1/audio/speech');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer sk_test');
  assert.strictEqual(seen.init.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(seen.init.body), { input: 'Hi there', voice_id: 'geffen_32', model: DEFAULT_MODEL, audio_format: 'mp3' });
  assert.deepStrictEqual(Array.from(r.audio), Array.from(AUDIO));
  assert.strictEqual(r.boundaries.length, 2);
  // Model and language settings reach the request; markup tags make the input SSML
  await synthesize('Wait <break time="400ms"/> go', 'speechify:geffen_32', { key: 'sk_test', model: 'simba-3.2', language: 'fr-FR', fetchImpl });
  assert.deepStrictEqual(JSON.parse(seen.init.body), { input: '<speak>Wait <break time="400ms"/> go</speak>', voice_id: 'geffen_32', model: 'simba-3.2', audio_format: 'mp3', language: 'fr-FR' });
});

test('stream returns the raw audio bytes and allows the longer limit', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(AUDIO, { headers: { 'Content-Type': 'audio/mpeg' } }); };
  const r = await stream('x'.repeat(MAX_CHARS + 1), 'speechify:geffen_32', { key: 'sk_test', fetchImpl });
  assert.strictEqual(seen.url, 'https://api.speechify.ai/v1/audio/stream');
  assert.strictEqual(JSON.parse(seen.init.body).voice_id, 'geffen_32');
  assert.deepStrictEqual(Array.from(r.audio), Array.from(AUDIO));
  await assert.rejects(stream('x'.repeat(MAX_STREAM_CHARS + 1), 'speechify:geffen_32', { key: 'sk_test', fetchImpl }), { status: 422 });
  await assert.rejects(stream('hi', 'speechify:geffen_32', { key: 'sk_test', fetchImpl: async () => new Response(new Uint8Array(0)) }), { status: 502, message: /no audio/ });
});

test('requests are validated before any network use', async () => {
  const mustNotRun = async () => { throw new Error('network used'); };
  await assert.rejects(synthesize('hi', 'speechify:geffen_32', { key: '', fetchImpl: mustNotRun }), { status: 503, message: /SPEECHIFY_API_KEY/ });
  await assert.rejects(synthesize('hi', 'speechify:bad id', { key: 'k', fetchImpl: mustNotRun }), { status: 400 });
  await assert.rejects(synthesize('x'.repeat(MAX_CHARS + 1), 'speechify:geffen_32', { key: 'k', fetchImpl: mustNotRun }), { status: 422, message: /2000 characters/ });
});

test('Speechify failures become plain-language errors with sensible statuses', async () => {
  const run = (status, body, headers) => synthesize('hi', 'speechify:geffen_32', { key: 'k', fetchImpl: async () => jsonRes(body, status, headers) });
  await assert.rejects(run(401, { error: { code: 'unauthorized', message: 'bad key' } }), { status: 502, message: /rejected the API key \(bad key\): check SPEECHIFY_API_KEY/ });
  await assert.rejects(run(402, { error: { code: 'insufficient_credits', message: 'no credits' } }), { status: 429, message: /credits.*used up.*Edge voices still work/ });
  await assert.rejects(run(400, { error: { code: 'model_retired', message: 'simba-english is retired' } }), { status: 502, message: /retired the configured model.*SPEECHIFY_MODEL to simba-3.5/ });
  await assert.rejects(run(400, { error: { code: 'content_policy_violation', message: 'nope' } }), { status: 422, message: /content policy/ });
  await assert.rejects(run(400, { error: { code: 'validation_failed', message: 'input: malformed SSML' } }), { status: 422, message: /rejected the request \(input: malformed SSML\)/ });
  await assert.rejects(run(404, { error: { code: 'not_found', message: 'voice' } }), { status: 404, message: /No such Speechify voice/ });
  await assert.rejects(run(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'Retry-After': '7' }), { status: 429, message: /try again in 7 seconds/ });
  await assert.rejects(run(503, { error: { code: 'unavailable', message: 'down' } }), { status: 502, message: /HTTP 503 \(down\)/ });
  await assert.rejects(run(500, 'not json'), { status: 502, message: /HTTP 500$/ });
  await assert.rejects(run(200, { nope: true }), { status: 502, message: /no audio/ });
  await assert.rejects(synthesize('hi', 'speechify:geffen_32', { key: 'k', fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } }), { status: 504 });
  await assert.rejects(synthesize('hi', 'speechify:geffen_32', { key: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } }), { status: 502, message: /ECONNRESET/ });
});

test('sample serves the preview clip, or the cloned voice sample download, with an audio content type', async () => {
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://api.speechify.ai/v1/voices?')) return jsonRes({ voices: [VOICE, { id: 'mine', display_name: 'Mine', type: 'personal', gender: 'female', locale: 'en-US', models: [] }, { id: 'bare', display_name: 'Bare', type: 'shared', gender: 'female', locale: 'en-US', models: [] }], has_more: false });
    if (url === 'https://cdn.example/geffen.mp3') return new Response('ID3preview', { headers: { 'Content-Type': 'text/plain' } });
    if (url === 'https://api.speechify.ai/v1/voices/mine/sample') { assert.strictEqual(init.headers.Authorization, 'Bearer k'); return new Response('ID3clone', { headers: { 'Content-Type': 'audio/wav' } }); }
    throw new Error(`unexpected ${url}`);
  };
  const shared = await sample('k', 'speechify:geffen_32', { fetchImpl });
  assert.deepStrictEqual([Buffer.from(shared.audio).toString(), shared.contentType], ['ID3preview', 'audio/mpeg']);
  const cloned = await sample('k', 'speechify:mine', { fetchImpl });
  assert.deepStrictEqual([Buffer.from(cloned.audio).toString(), cloned.contentType], ['ID3clone', 'audio/wav']);
  await assert.rejects(sample('k', 'speechify:bare', { fetchImpl }), { status: 404, message: /no preview clip/ });
  await assert.rejects(sample('k', 'speechify:nobody', { fetchImpl }), { status: 404, message: /No such Speechify voice/ });
});
