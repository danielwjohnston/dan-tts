// The ElevenLabs provider, offline: fetch is replaced with canned responses.
import test from 'node:test';
import assert from 'node:assert';
import { alignmentToBoundaries, listVoices, synthesize, sample, usage, ID_RE, MAX_CHARS, DEFAULT_MODEL } from '../src/elevenlabs.js';

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const AUDIO = Uint8Array.from([0x49, 0x44, 0x33, 1, 2, 3]); // "ID3" + bytes
const AUDIO_B64 = Buffer.from(AUDIO).toString('base64');

// "Hi there" spoken over 0.00s-0.95s
const ALIGNMENT = {
  characters: ['H', 'i', ' ', 't', 'h', 'e', 'r', 'e'],
  character_start_times_seconds: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.95],
};

test('voice ids are eleven:<id>', () => {
  assert.ok(ID_RE.test('eleven:21m00Tcm4TlvDq8ikWAM'));
  assert.ok(!ID_RE.test('eleven:'));
  assert.ok(!ID_RE.test('eleven:../x'));
  assert.ok(!ID_RE.test('en-US-AriaNeural'));
});

test('per-character times become word boundaries in 100 ns ticks', () => {
  assert.deepStrictEqual(alignmentToBoundaries(ALIGNMENT), [
    { offset: 0, duration: 2_000_000, text: 'Hi' },
    { offset: 3_000_000, duration: 6_500_000, text: 'there' },
  ]);
  assert.deepStrictEqual(alignmentToBoundaries(undefined), []);
  assert.deepStrictEqual(alignmentToBoundaries({ characters: [' ', '\n'] }), []);
});

test('listVoices follows pages and returns the /voices shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, key: init.headers['xi-api-key'] });
    if (url.includes('next_page_token=tok2')) {
      return jsonRes({ voices: [{ voice_id: 'bbbbbbbbbbbb', name: 'Bella', category: 'premade', labels: {}, preview_url: '' }], has_more: false });
    }
    return jsonRes({
      voices: [{ voice_id: 'aaaaaaaaaaaa', name: 'Adam', category: 'premade', preview_url: 'https://cdn.example/adam.mp3',
        labels: { gender: 'male', accent: 'american', age: 'middle-aged', use_case: 'narration', language: 'en' } }],
      has_more: true, next_page_token: 'tok2',
    });
  };
  const voices = await listVoices('secret', { fetchImpl });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls.every((c) => c.key === 'secret'));
  assert.deepStrictEqual(voices[0], {
    name: 'Adam', shortName: 'eleven:aaaaaaaaaaaa', locale: 'en', localeName: 'American · Middle-aged · Narration', gender: 'Male',
    styleList: [], provider: 'elevenlabs', category: 'premade', previewUrl: 'https://cdn.example/adam.mp3', sampleUrl: '/samples/eleven:aaaaaaaaaaaa',
  });
  assert.strictEqual(voices[1].shortName, 'eleven:bbbbbbbbbbbb');
  assert.strictEqual(voices[1].gender, '');
});

test('synthesize posts to with-timestamps and decodes audio plus boundaries', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return jsonRes({ audio_base64: AUDIO_B64, alignment: ALIGNMENT }); };
  const { audio, boundaries } = await synthesize('Hi there', 'eleven:21m00Tcm4TlvDq8ikWAM', { key: 'secret', fetchImpl });
  assert.ok(seen.url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/with-timestamps?output_format=mp3_44100_128'));
  assert.strictEqual(seen.init.method, 'POST');
  assert.strictEqual(seen.init.headers['xi-api-key'], 'secret');
  assert.deepStrictEqual(JSON.parse(seen.init.body), { text: 'Hi there', model_id: DEFAULT_MODEL });
  assert.deepStrictEqual([...audio], [...AUDIO]);
  assert.strictEqual(boundaries.length, 2);
  assert.strictEqual(boundaries[1].text, 'there');
});

test('synthesize validates before any network use', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  await assert.rejects(synthesize('hi', 'eleven:21m00Tcm4TlvDq8ikWAM', { fetchImpl }), { status: 503 });
  await assert.rejects(synthesize('hi', 'eleven:bad', { key: 'k', fetchImpl }), { status: 400 });
  await assert.rejects(synthesize('x'.repeat(MAX_CHARS + 1), 'eleven:21m00Tcm4TlvDq8ikWAM', { key: 'k', fetchImpl }), { status: 422 });
});

test('ElevenLabs failures map to plain-language errors', async () => {
  const run = (status, body) => synthesize('hi', 'eleven:21m00Tcm4TlvDq8ikWAM', { key: 'k', fetchImpl: async () => jsonRes(body, status) });
  await assert.rejects(run(401, { detail: { status: 'invalid_api_key', message: 'nope' } }), { status: 502, message: /rejected the API key/ });
  await assert.rejects(run(401, { detail: { status: 'quota_exceeded', message: 'out' } }), { status: 429, message: /credits for this month are used up/ });
  await assert.rejects(run(402, {}), { status: 429 });
  await assert.rejects(run(400, { detail: { status: 'max_character_limit_exceeded' } }), { status: 422, message: /too long/ });
  await assert.rejects(run(429, { detail: 'slow down' }), { status: 429, message: /rate-limiting/ });
  await assert.rejects(synthesize('hi', 'eleven:21m00Tcm4TlvDq8ikWAM', { key: 'k', fetchImpl: async () => new Response('not json', { status: 500 }) }), { status: 502, message: /HTTP 500/ });
  await assert.rejects(run(200, { alignment: ALIGNMENT }), { status: 502, message: /no audio/ });
});

test('sample serves the preview clip and 404s for unknown voices', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.elevenlabs.io/v2/voices')) {
      return jsonRes({ voices: [
        { voice_id: 'aaaaaaaaaaaa', name: 'Adam', preview_url: 'https://cdn.example/adam.mp3' },
        { voice_id: 'cccccccccccc', name: 'Quiet', preview_url: '' },
      ] });
    }
    if (url === 'https://cdn.example/adam.mp3') return new Response(AUDIO, { headers: { 'Content-Type': 'audio/mpeg' } });
    throw new Error(`unexpected ${url}`);
  };
  const { audio, contentType } = await sample('k', 'eleven:aaaaaaaaaaaa', { fetchImpl });
  assert.deepStrictEqual([...audio], [...AUDIO]);
  assert.strictEqual(contentType, 'audio/mpeg');
  await assert.rejects(sample('k', 'eleven:zzzzzzzzzzzz', { fetchImpl }), { status: 404 });
  await assert.rejects(sample('k', 'eleven:cccccccccccc', { fetchImpl }), { status: 404, message: /no preview/ });
});

// ---- Review follow-ups ----

test('network failures and unreadable bodies become 502/504, never a bare throw', async () => {
  const voice = 'eleven:21m00Tcm4TlvDq8ikWAM';
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  await assert.rejects(synthesize('hi', voice, { key: 'k', fetchImpl: async () => { throw timeout; } }), { status: 504, message: /timed out/ });
  await assert.rejects(synthesize('hi', voice, { key: 'k', fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { status: 502, message: /fetch failed/ });
  await assert.rejects(synthesize('hi', voice, { key: 'k', fetchImpl: async () => new Response('<html>busy</html>', { status: 200 }) }), { status: 502, message: /unreadable response/ });
  await assert.rejects(synthesize('hi', voice, { key: 'k', fetchImpl: async () => jsonRes({ audio_base64: '%%%not base64%%%' }) }), { status: 502, message: /unreadable audio/ });
  await assert.rejects(listVoices('k', { fetchImpl: async () => { throw timeout; } }), { status: 504 });
  await assert.rejects(listVoices('k', { fetchImpl: async () => new Response('null', { status: 200 }) }), { status: 502 });
  // a non-JSON error body still maps by status
  await assert.rejects(synthesize('hi', voice, { key: 'k', fetchImpl: async () => new Response('Bad gateway', { status: 500 }) }), { status: 502, message: /HTTP 500/ });
});

test('a rejected key keeps the provider\'s own explanation', async () => {
  const fetchImpl = async () => jsonRes({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401);
  await assert.rejects(synthesize('hi', 'eleven:21m00Tcm4TlvDq8ikWAM', { key: 'k', fetchImpl }), { status: 502, message: /rejected the API key \(Invalid API key\)/ });
});

test('an invalid id is reported before a missing key, and length counts code points', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  await assert.rejects(synthesize('hi', 'eleven:bad', { fetchImpl }), { status: 400 });
  const emoji = '😀'.repeat(MAX_CHARS); // 2 UTF-16 units each, but MAX_CHARS code points: allowed
  const fetchOk = async () => jsonRes({ audio_base64: AUDIO_B64, alignment: {} });
  assert.strictEqual((await synthesize(emoji, 'eleven:21m00Tcm4TlvDq8ikWAM', { key: 'k', fetchImpl: fetchOk })).boundaries.length, 0);
  await assert.rejects(synthesize(emoji + 'x', 'eleven:21m00Tcm4TlvDq8ikWAM', { key: 'k', fetchImpl: fetchOk }), { status: 422 });
});

test('word splitting matches the Python server on odd whitespace and multi-character entries', () => {
  const t = (chars) => alignmentToBoundaries({ characters: chars, character_start_times_seconds: chars.map((_, i) => i / 10), character_end_times_seconds: chars.map((_, i) => (i + 1) / 10) }).map((b) => b.text);
  assert.deepStrictEqual(t(['a', '﻿', 'b', ' ', 'c']), ['a', 'b', 'c']);        // BOM separates, on both servers
  assert.deepStrictEqual(t(['a', '\u0085', 'b', ' ', 'c']), ['a\u0085b', 'c']);      // NEL does not, on both servers
  assert.deepStrictEqual(t(['Hello ', 'world']), ['Hello world']);                    // a multi-character entry is never dropped
  assert.deepStrictEqual(t(['Hi', '  ', 'there']), ['Hi', 'there']);
});

test('ticks round half up like the Python server', () => {
  const b = alignmentToBoundaries({ characters: ['a'], character_start_times_seconds: [0.00000005], character_end_times_seconds: [0.00000025] });
  assert.deepStrictEqual(b, [{ offset: 1, duration: 2, text: 'a' }]);
});

test('sample refuses a preview clip that is not served over https', async () => {
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.elevenlabs.io/v2/voices')) return jsonRes({ voices: [{ voice_id: 'aaaaaaaaaaaa', name: 'Adam', preview_url: 'http://169.254.169.254/latest/meta-data' }] });
    throw new Error(`must not fetch ${url}`);
  };
  await assert.rejects(sample('k', 'eleven:aaaaaaaaaaaa', { fetchImpl }), { status: 502, message: /not https/ });
});

test('usage reports this month\'s credits from the subscription endpoint', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, key: init.headers['xi-api-key'] }; return jsonRes({ tier: 'free', character_count: 150, character_limit: 10000, next_character_count_reset_unix: 1762128000 }); };
  const u = await usage('secret', { fetchImpl });
  assert.strictEqual(seen.url, 'https://api.elevenlabs.io/v1/user/subscription');
  assert.strictEqual(seen.key, 'secret');
  assert.deepStrictEqual(u, { provider: 'elevenlabs', tier: 'free', used: 150, limit: 10000, remaining: 9850, resetsAt: '2025-11-03T00:00:00Z' });
  await assert.rejects(usage('bad', { fetchImpl: async () => jsonRes({ detail: { status: 'invalid_api_key' } }, 401) }), { status: 502 });
  const over = await usage('k', { fetchImpl: async () => jsonRes({ character_count: 12000, character_limit: 10000 }) });
  assert.strictEqual(over.remaining, 0);
  assert.strictEqual(over.resetsAt, null);
  // Odd values coerce the same way as on the Python server: whole numbers, never a throw
  const odd = await usage('k', { fetchImpl: async () => jsonRes({ character_count: '150.7', character_limit: 10000.2, next_character_count_reset_unix: '1762128000', tier: null }) });
  assert.deepStrictEqual(odd, { provider: 'elevenlabs', tier: '', used: 150, limit: 10000, remaining: 9850, resetsAt: '2025-11-03T00:00:00Z' });
  assert.strictEqual((await usage('k', { fetchImpl: async () => jsonRes({ character_count: 'abc' }) })).used, 0);
  await assert.rejects(usage('k', { fetchImpl: async () => jsonRes([1, 2]) }), { status: 502, message: /unreadable/ });
});
