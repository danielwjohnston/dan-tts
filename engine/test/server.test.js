// Server voices (provider voices behind the project's own API), offline.
import test from 'node:test';
import assert from 'node:assert';
import { DEFAULT_SERVER, isServerVoice, serverFor, providerLabel, listServerVoices, synthesizeServer } from '../src/server.js';

const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('provider ids are recognised by their prefix; Edge ids are not', () => {
  assert.ok(isServerVoice('eleven:21m00Tcm4TlvDq8ikWAM'));
  assert.ok(isServerVoice('azure:en-US-JennyNeural'));
  assert.ok(!isServerVoice('en-US-AriaNeural'));
  assert.ok(!isServerVoice(''));
  assert.ok(!isServerVoice(undefined));
});

test('serverFor: unset means the default, empty means off, otherwise the URL without a slash', () => {
  assert.strictEqual(serverFor(undefined), DEFAULT_SERVER);
  assert.strictEqual(serverFor(null), DEFAULT_SERVER);
  assert.strictEqual(serverFor(''), '');
  assert.strictEqual(serverFor('  http://127.0.0.1:8787/// '), 'http://127.0.0.1:8787');
  assert.strictEqual(providerLabel('elevenlabs'), 'ElevenLabs');
  assert.strictEqual(providerLabel('azure'), 'Azure AI Speech');
  assert.strictEqual(providerLabel('polly'), 'Amazon Polly');
  assert.strictEqual(providerLabel('acme'), 'Acme'); // an unknown provider is still labelled
});

test('listServerVoices keeps provider voices only, in the picker\'s shape', async () => {
  let seen;
  const fetchImpl = async (url) => { seen = url; return jsonRes([
    { name: 'Aria', shortName: 'en-US-AriaNeural', locale: 'en-US', localeName: 'English (United States)', gender: 'Female', provider: 'edge' },
    { name: 'Adam', shortName: 'eleven:aaaaaaaaaaaa', locale: 'en', localeName: 'American · Narration', gender: 'Male', provider: 'elevenlabs' },
    { name: 'Quiet', shortName: 'eleven:bbbbbbbbbbbb', provider: 'elevenlabs' },
    { shortName: 'bogus', provider: 'elevenlabs' },
    null,
  ]); };
  const voices = await listServerVoices('http://127.0.0.1:1/', { fetchImpl });
  assert.strictEqual(seen, 'http://127.0.0.1:1/voices');
  assert.deepStrictEqual(voices, [
    { ShortName: 'eleven:aaaaaaaaaaaa', Locale: 'en', LocaleName: 'American · Narration', Gender: 'Male', FriendlyName: 'Adam', Provider: 'elevenlabs' },
    { ShortName: 'eleven:bbbbbbbbbbbb', Locale: '', LocaleName: '', Gender: '', FriendlyName: 'Quiet', Provider: 'elevenlabs' },
  ]);
  assert.deepStrictEqual(await listServerVoices('', { fetchImpl }), []);
  await assert.rejects(listServerVoices('http://x', { fetchImpl: async () => jsonRes({ detail: 'nope' }, 500) }), { message: 'Voice server: nope' });
  await assert.rejects(listServerVoices('http://x', { fetchImpl: async () => jsonRes({ not: 'a list' }) }), { message: /unexpected voice list/ });
});

test('synthesizeServer posts the chunk and decodes audio and boundaries', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return jsonRes({ audio: Buffer.from('ID3abc').toString('base64'), contentType: 'audio/mpeg', boundaries: [{ offset: 0, duration: 2000000, text: 'Hi' }, { offset: '3000000', duration: null, text: 'there' }] }); };
  const r = await synthesizeServer('Hi there', { voice: 'eleven:aaaaaaaaaaaa', server: 'http://127.0.0.1:1', fetchImpl });
  assert.strictEqual(seen.url, 'http://127.0.0.1:1/synthesize_with_timing');
  assert.strictEqual(seen.init.method, 'POST');
  assert.deepStrictEqual(JSON.parse(seen.init.body), { text: 'Hi there', voice: 'eleven:aaaaaaaaaaaa', format: 'mp3' });
  assert.strictEqual(Buffer.from(r.audio).toString(), 'ID3abc');
  assert.deepStrictEqual(r.boundaries, [{ offset: 0, duration: 2000000, text: 'Hi' }, { offset: 3000000, duration: 0, text: 'there' }]);
  assert.strictEqual(r.contentType, 'audio/mpeg');
});

test('synthesizeServer surfaces the server\'s reason and refuses when turned off', async () => {
  const run = (body, status) => synthesizeServer('x', { voice: 'eleven:aaaaaaaaaaaa', server: 'http://x', fetchImpl: async () => jsonRes(body, status) });
  await assert.rejects(run({ detail: 'ElevenLabs credits for this month are used up. Edge voices still work; credits reset monthly' }, 429), { message: /credits for this month/ });
  await assert.rejects(run('oops', 502), { message: 'HTTP 502' });
  await assert.rejects(run({ boundaries: [] }), { message: /no audio/ });
  await assert.rejects(run({ audio: '%%%', boundaries: [] }), { message: /unreadable audio/ });
  await assert.rejects(synthesizeServer('x', { voice: 'eleven:aaaaaaaaaaaa', server: '' }), { message: /turned off/ });
});

test('an unreachable or silent server is reported in plain words, naming the host', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(listServerVoices('http://127.0.0.1:9/', { fetchImpl: down }), { message: /Could not reach the voice server \(127\.0\.0\.1:9\)\. Pick an Edge voice/ });
  const slow = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
  await assert.rejects(synthesizeServer('x', { voice: 'eleven:aaaaaaaaaaaa', server: 'https://voices.example', fetchImpl: slow }), { message: /did not answer in time \(voices\.example\)/ });
});
