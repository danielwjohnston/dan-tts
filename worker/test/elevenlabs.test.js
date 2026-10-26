// The ElevenLabs provider, offline: fetch is replaced with canned responses.
import test from 'node:test';
import assert from 'node:assert';
import { alignmentToBoundaries, listVoices, synthesize, sample, ID_RE, MAX_CHARS, DEFAULT_MODEL } from '../src/elevenlabs.js';

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
  await assert.rejects(run(500, 'not json'), { status: 502, message: /HTTP 500/ });
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
