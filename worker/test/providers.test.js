// Azure, Google, Polly and OpenAI adapters, offline: fetch and sockets are replaced with canned answers.
import test from 'node:test';
import assert from 'node:assert';
import * as azure from '../src/azure.js';
import * as google from '../src/google.js';
import * as polly from '../src/polly.js';
import * as openai from '../src/openai.js';
import { mp3 } from './helpers.js';
import { ssmlWithMarks } from '../src/audio.js';

const jsonRes = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const bytesRes = (bytes, type = 'audio/mpeg') => new Response(bytes, { headers: { 'Content-Type': type } });
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// ---- Azure ----
const AZURE_ENV = { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'eastus' };

function fakeAzureSocket(script) {
  const factory = (url, headers) => {
    const ws = { readyState: 1, sent: [], url, headers, send(d) { this.sent.push(d); if (this.sent.length === 2) queueMicrotask(() => script.forEach((f) => this.onmessage({ data: f }))); }, close() {} };
    factory.last = ws;
    return ws;
  };
  return factory;
}
const textFrame = (path, body) => `X-RequestId:abc\r\nContent-Type:application/json\r\nPath:${path}\r\n\r\n${body}`;
function binaryFrame(bytes) {
  const header = new TextEncoder().encode('X-RequestId:abc\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n');
  const buf = new Uint8Array(2 + header.length + bytes.length);
  buf[0] = header.length >> 8; buf[1] = header.length & 255; buf.set(header, 2); buf.set(bytes, 2 + header.length);
  return buf.buffer;
}
const meta = (text, offset, duration, type = 'WordBoundary') => textFrame('audio.metadata', JSON.stringify({ Metadata: [{ Type: 'WordBoundary', Data: { Offset: offset, Duration: duration, text: { Text: text, BoundaryType: type } } }] }));

test('azure: ids, voice list for the configured locales, and the /voices shape', async () => {
  assert.ok(azure.ID_RE.test('azure:en-US-JennyNeural') && azure.ID_RE.test('azure:en-US-Ava:DragonHDLatestNeural') && azure.ID_RE.test('azure:zh-CN-shaanxi-XiaoniNeural'));
  assert.ok(!azure.ID_RE.test('azure:') && !azure.ID_RE.test('azure:../x') && !azure.ID_RE.test('en-US-AriaNeural'));
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return jsonRes([
    { ShortName: 'en-US-JennyNeural', DisplayName: 'Jenny', Locale: 'en-US', LocaleName: 'English (United States)', Gender: 'Female', StyleList: ['chat'], VoiceType: 'Neural' },
    { ShortName: 'de-DE-KatjaNeural', DisplayName: 'Katja', Locale: 'de-DE', Gender: 'Female' },
    { ShortName: 'en-US-Ava:DragonHDLatestNeural', DisplayName: 'Ava Dragon HD Latest', Locale: 'en-US', LocaleName: 'English (United States)', Gender: 'Female', VoiceType: 'NeuralHD' },
  ]); };
  const voices = await azure.listVoices(AZURE_ENV, { fetchImpl });
  assert.strictEqual(seen.url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list');
  assert.strictEqual(seen.init.headers['Ocp-Apim-Subscription-Key'], 'k');
  assert.deepStrictEqual(voices.map((v) => [v.shortName, v.name, v.provider, v.gender, v.localeName, v.sampleUrl]), [
    ['azure:en-US-JennyNeural', 'Jenny', 'azure', 'Female', 'English (United States)', '/samples/azure:en-US-JennyNeural'],
    ['azure:en-US-Ava:DragonHDLatestNeural', 'Ava Dragon HD Latest', 'azure', 'Female', 'English (United States) · NeuralHD', '/samples/azure:en-US-Ava:DragonHDLatestNeural'],
  ]);
  assert.deepStrictEqual(voices[0].styleList, ['chat']);
  const all = await azure.listVoices({ ...AZURE_ENV, VOICE_LOCALES: '*' }, { fetchImpl });
  assert.strictEqual(all.length, 3);
  await assert.rejects(azure.listVoices(AZURE_ENV, { fetchImpl: async () => new Response('denied', { status: 401 }) }), { status: 502, message: /rejected the key or region/ });
});

test('azure: synthesis goes through the engine with the key header, real SSML and word-only boundaries', async () => {
  const script = [meta('Hello', 1000000, 4000000), meta(',', 5000000, 100000, 'PunctuationBoundary'), binaryFrame(mp3(3)), meta('there', 6000000, 3000000), textFrame('turn.end', '{}')];
  const openSocket = fakeAzureSocket(script);
  const r = await azure.synthesize('Hello, <break time="0.4s" /> there & co', 'azure:en-US-JennyNeural', AZURE_ENV, { openSocket });
  assert.deepStrictEqual(r.boundaries, [{ offset: 1000000, duration: 4000000, text: 'Hello' }, { offset: 6000000, duration: 3000000, text: 'there' }]);
  assert.strictEqual(r.audio.length, 3 * 144);
  assert.match(openSocket.last.url, /^wss:\/\/eastus\.tts\.speech\.microsoft\.com\/cognitiveservices\/websocket\/v1\?X-ConnectionId=[0-9a-f]{32}$/);
  assert.deepStrictEqual(openSocket.last.headers, { 'Ocp-Apim-Subscription-Key': 'k' });
  const ssml = openSocket.last.sent[1].split('\r\n\r\n')[1];
  assert.strictEqual(ssml, "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='en-US-JennyNeural'>Hello, <break time=\"400ms\"/> there &amp; co</voice></speak>");
});

test('azure: validation before any network, and connection failures in plain words', async () => {
  const never = () => { throw new Error('no socket expected'); };
  await assert.rejects(azure.synthesize('hi', 'azure:bad', AZURE_ENV, { openSocket: never }), { status: 400 });
  await assert.rejects(azure.synthesize('hi', 'azure:en-US-JennyNeural', {}, { openSocket: never }), { status: 503, message: /AZURE_SPEECH_KEY/ });
  const { HttpError } = await import('../src/extract.js');
  await assert.rejects(azure.synthesize('hi', 'azure:en-US-JennyNeural', AZURE_ENV, { openSocket: async () => { throw new HttpError(502, 'Voice service refused the connection (HTTP 401)'); } }), { status: 502, message: /rejected the key or region/ });
  await assert.rejects(azure.synthesize('hi', 'azure:en-US-JennyNeural', AZURE_ENV, { openSocket: async () => { throw new HttpError(502, 'Voice service refused the connection (HTTP 429)'); } }), { status: 429 });
  await assert.rejects(azure.synthesize('hi', 'azure:en-US-JennyNeural', AZURE_ENV, { openSocket: async () => { throw new Error('TTS timed out'); } }), { status: 504 });
});

// ---- Google ----
const GOOGLE_ENV = { GOOGLE_TTS_API_KEY: 'g' };

test('google: ids, voice list, and timings from SSML marks', async () => {
  assert.ok(google.ID_RE.test('google:en-US-Neural2-F') && google.ID_RE.test('google:en-US-Chirp3-HD-Aoede') && !google.ID_RE.test('google:x') && !google.ID_RE.test('google:en-US-Neural2/F'));
  assert.ok(google.takesSsml('en-US-Neural2-F') && !google.takesSsml('en-US-Chirp3-HD-Aoede') && !google.takesSsml('en-US-Journey-D'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://texttospeech.googleapis.com/v1/voices')) {
      return jsonRes({ voices: [
        { languageCodes: ['en-US'], name: 'en-US-Neural2-F', ssmlGender: 'FEMALE' },
        { languageCodes: ['en-US'], name: 'en-US-Chirp3-HD-Aoede', ssmlGender: 'FEMALE' },
        { languageCodes: ['en-US'], name: 'en-US-Studio-O', ssmlGender: 'NEUTRAL' },
      ] });
    }
    const body = JSON.parse(init.body);
    if (body.input.ssml) {
      assert.deepStrictEqual(body.enableTimePointing, ['SSML_MARK']);
      assert.strictEqual(body.input.ssml, '<speak><mark name="0"/>Hi <mark name="1"/>there</speak>');
      assert.deepStrictEqual(body.voice, { languageCode: 'en-US', name: 'en-US-Neural2-F' });
      return jsonRes({ audioContent: b64(mp3(10)), timepoints: [{ markName: '0', timeSeconds: 0.1 }, { markName: '1', timeSeconds: 0.14 }] });
    }
    assert.strictEqual(body.enableTimePointing, undefined);
    return jsonRes({ audioContent: b64(mp3(10)) });
  };
  const voices = await google.listVoices(GOOGLE_ENV, { fetchImpl });
  assert.strictEqual(calls[0].url, 'https://texttospeech.googleapis.com/v1/voices?languageCode=en-US');
  assert.strictEqual(calls[0].init.headers['x-goog-api-key'], 'g');
  assert.deepStrictEqual(voices.map((v) => [v.shortName, v.name, v.gender, v.localeName]), [
    ['google:en-US-Neural2-F', 'Neural2 F', 'Female', 'en-US'],
    ['google:en-US-Chirp3-HD-Aoede', 'Chirp3 HD Aoede', 'Female', 'en-US · Timings estimated'],
    ['google:en-US-Studio-O', 'Studio O', '', 'en-US'],
  ]);
  const r = await google.synthesize('Hi there', 'google:en-US-Neural2-F', GOOGLE_ENV, { fetchImpl });
  assert.strictEqual(r.audio.length, 1440);
  assert.deepStrictEqual(r.boundaries, [{ offset: 1_000_000, duration: 400_000, text: 'Hi' }, { offset: 1_400_000, duration: 1_000_000, text: 'there' }]); // the last word lasts to the end (10 × 24 ms)
  const est = await google.synthesize('Hi there', 'google:en-US-Chirp3-HD-Aoede', GOOGLE_ENV, { fetchImpl });
  assert.deepStrictEqual(est.boundaries.map((b) => b.text), ['Hi', 'there']);
  assert.strictEqual(est.boundaries[1].offset + est.boundaries[1].duration, 2_400_000);
});

test('google: marked pieces stay under the byte limit; errors are plain', async () => {
  const text = ('a '.repeat(400) + '\n\n').repeat(3); // tiny words: marks dwarf the text
  const parts = google.markedPieces(text);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(new TextEncoder().encode(`<speak>${ssmlWithMarks(p).body}</speak>`).length <= 5000);
  await assert.rejects(google.synthesize('hi', 'google:en-US-Neural2-F', {}), { status: 503, message: /GOOGLE_TTS_API_KEY/ });
  await assert.rejects(google.synthesize('hi', 'google:bad', GOOGLE_ENV), { status: 400 });
  const err = (status, message) => ({ fetchImpl: async () => jsonRes({ error: { code: status, message, status: 'X' } }, status) });
  await assert.rejects(google.synthesize('hi', 'google:en-US-Neural2-F', GOOGLE_ENV, err(400, 'API key not valid. Please pass a valid API key.')), { status: 502, message: /rejected the API key/ });
  await assert.rejects(google.synthesize('hi', 'google:en-US-Neural2-F', GOOGLE_ENV, err(429, 'Quota exceeded')), { status: 429 });
  await assert.rejects(google.synthesize('hi', 'google:en-US-Neural2-F', GOOGLE_ENV, err(400, 'Voice en-US-Neural2-F does not exist')), { status: 400, message: /No such/ });
  await assert.rejects(google.synthesize('hi', 'google:en-US-Neural2-F', GOOGLE_ENV, { fetchImpl: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } }), { status: 504 });
});

// ---- Polly ----
const POLLY_ENV = { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', AWS_REGION: 'us-west-2' };

test('polly: the SigV4 signing key matches the AWS worked example, and requests carry a signature', async () => {
  const key = await polly.signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
  assert.strictEqual(Array.from(new Uint8Array(key), (b) => b.toString(16).padStart(2, '0')).join(''), 'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  const h = await polly.signV4({ method: 'POST', url: 'https://polly.us-west-2.amazonaws.com/v1/speech', body: '{"a":1}', env: POLLY_ENV, now: new Date('2026-10-26T12:34:56Z') });
  assert.strictEqual(h['x-amz-date'], '20261026T123456Z');
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261026\/us-west-2\/polly\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.strictEqual(h.host, undefined);
  const withToken = await polly.signV4({ method: 'GET', url: 'https://polly.us-west-2.amazonaws.com/v1/voices?LanguageCode=en-US', env: { ...POLLY_ENV, AWS_SESSION_TOKEN: 't' } });
  assert.match(withToken.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  assert.strictEqual(withToken['x-amz-security-token'], 't');
});

test('polly: voices, then audio and word marks in two signed requests per piece', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/polly\/aws4_request/);
    if (url.startsWith('https://polly.us-west-2.amazonaws.com/v1/voices')) {
      if (url.includes('NextToken=')) return jsonRes({ Voices: [{ Id: 'Matthew', Name: 'Matthew', Gender: 'Male', LanguageCode: 'en-US', LanguageName: 'US English', SupportedEngines: ['neural', 'standard'] }] });
      return jsonRes({ Voices: [
        { Id: 'Joanna', Name: 'Joanna', Gender: 'Female', LanguageCode: 'en-US', LanguageName: 'US English', SupportedEngines: ['neural', 'standard', 'generative'] },
        { Id: 'Kendra', Name: 'Kendra', Gender: 'Female', LanguageCode: 'en-US', LanguageName: 'US English', SupportedEngines: ['standard'] },
      ], NextToken: 'n2' });
    }
    const body = JSON.parse(init.body);
    assert.deepStrictEqual([body.VoiceId, body.Engine, body.TextType], ['Joanna', 'neural', 'text']);
    if (body.OutputFormat === 'mp3') return bytesRes(mp3(10));
    assert.deepStrictEqual(body.SpeechMarkTypes, ['word']);
    return new Response('{"time":6,"type":"word","start":0,"end":5,"value":"Hello"}\n{"time":120,"type":"word","start":6,"end":11,"value":"world"}\n', { headers: { 'Content-Type': 'application/x-json-stream' } });
  };
  const voices = await polly.listVoices(POLLY_ENV, { fetchImpl });
  assert.strictEqual(calls[0].url, 'https://polly.us-west-2.amazonaws.com/v1/voices?LanguageCode=en-US');
  assert.deepStrictEqual(voices.map((v) => [v.shortName, v.name, v.gender, v.localeName]), [
    ['polly:Joanna', 'Joanna', 'Female', 'US English'],
    ['polly:Kendra', 'Kendra', 'Female', 'US English · standard'],
    ['polly:Matthew', 'Matthew', 'Male', 'US English'],
  ]);
  const r = await polly.synthesize('Hello world', 'polly:Joanna', POLLY_ENV, { fetchImpl });
  assert.strictEqual(r.audio.length, 1440);
  assert.deepStrictEqual(r.boundaries, [{ offset: 60_000, duration: 1_140_000, text: 'Hello' }, { offset: 1_200_000, duration: 1_200_000, text: 'world' }]);
  assert.strictEqual(calls.filter((c) => c.url.endsWith('/v1/speech')).length, 2);
});

test('polly: SSML when the text has break tags; a voice without the neural engine falls back to standard; plain errors', async () => {
  const engines = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    engines.push(body.Engine);
    if (body.Engine === 'neural') return jsonRes({ message: 'This voice does not support the selected engine: neural' }, 400, { 'x-amzn-ErrorType': 'EngineNotSupportedException:http://internal.amazon.com/coral/com.amazon.polly/' });
    assert.strictEqual(body.TextType, 'ssml');
    assert.strictEqual(body.Text, '<speak>Wait <break time="800ms"/> here</speak>');
    return body.OutputFormat === 'mp3' ? bytesRes(mp3(2)) : new Response('{"time":0,"type":"word","start":7,"end":11,"value":"Wait"}\n');
  };
  const r = await polly.synthesize('Wait <break time="0.8s" /> here', 'polly:Kendra', POLLY_ENV, { fetchImpl });
  assert.deepStrictEqual(engines, ['neural', 'neural', 'standard', 'standard']);
  assert.deepStrictEqual(r.boundaries, [{ offset: 0, duration: 480_000, text: 'Wait' }]);
  await assert.rejects(polly.synthesize('hi', 'polly:Joanna', {}), { status: 503, message: /AWS_ACCESS_KEY_ID/ });
  await assert.rejects(polly.synthesize('hi', 'polly:no such', POLLY_ENV), { status: 400 });
  const err = (status, type, message) => ({ fetchImpl: async () => jsonRes({ message }, status, { 'x-amzn-ErrorType': type }) });
  await assert.rejects(polly.synthesize('hi', 'polly:Joanna', POLLY_ENV, err(403, 'InvalidSignatureException', 'bad sig')), { status: 502, message: /rejected the credentials/ });
  await assert.rejects(polly.synthesize('hi', 'polly:Joanna', POLLY_ENV, err(400, 'TextLengthExceededException', '')), { status: 422 });
  await assert.rejects(polly.synthesize('hi', 'polly:Joanna', POLLY_ENV, err(400, 'ThrottlingException', '')), { status: 429 });
  await assert.rejects(polly.synthesize('hi', 'polly:Nobody', POLLY_ENV, err(400, 'ValidationException', "1 validation error detected: Value 'Nobody' at 'voiceId'")), { status: 400, message: /No such Amazon Polly voice/ });
});

// ---- OpenAI ----
const OPENAI_ENV = { OPENAI_API_KEY: 'sk' };

test('openai: a fixed voice list, audio in, estimated timings out', async () => {
  const voices = await openai.listVoices();
  assert.deepStrictEqual(voices.slice(0, 2).map((v) => [v.shortName, v.name, v.provider, v.localeName]), [['openai:alloy', 'Alloy', 'openai', 'Timings estimated'], ['openai:ash', 'Ash', 'openai', 'Timings estimated']]);
  assert.ok(voices.every((v) => openai.ID_RE.test(v.shortName)));
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return bytesRes(mp3(10)); };
  const r = await openai.synthesize('Hello there, world.', 'openai:alloy', { ...OPENAI_ENV, OPENAI_TTS_MODEL: 'tts-1' }, { fetchImpl });
  assert.strictEqual(seen.url, 'https://api.openai.com/v1/audio/speech');
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer sk');
  assert.deepStrictEqual(JSON.parse(seen.init.body), { model: 'tts-1', input: 'Hello there, world.', voice: 'alloy', response_format: 'mp3' });
  assert.deepStrictEqual(r.boundaries.map((b) => b.text), ['Hello', 'there,', 'world.']);
  assert.strictEqual(r.boundaries[0].offset, 0);
  assert.ok(r.boundaries[2].offset + r.boundaries[2].duration <= 2_400_000);
  const dflt = async () => { await openai.synthesize('x', 'openai:alloy', OPENAI_ENV, { fetchImpl }); return JSON.parse(seen.init.body).model; };
  assert.strictEqual(await dflt(), openai.DEFAULT_MODEL);
});

test('openai: validation and plain errors', async () => {
  await assert.rejects(openai.synthesize('hi', 'openai:alloy', {}), { status: 503, message: /OPENAI_API_KEY/ });
  await assert.rejects(openai.synthesize('hi', 'openai:Alloy', OPENAI_ENV), { status: 400 });
  const err = (status, error) => ({ fetchImpl: async () => jsonRes({ error }, status) });
  await assert.rejects(openai.synthesize('hi', 'openai:alloy', OPENAI_ENV, err(401, { message: 'Incorrect API key provided' })), { status: 502, message: /rejected the API key \(Incorrect API key provided\)/ });
  await assert.rejects(openai.synthesize('hi', 'openai:alloy', OPENAI_ENV, err(429, { type: 'insufficient_quota', message: 'You exceeded your current quota' })), { status: 429, message: /out of credit/ });
  await assert.rejects(openai.synthesize('hi', 'openai:alloy', OPENAI_ENV, err(429, { type: 'requests', message: 'Rate limit reached' })), { status: 429, message: /rate-limiting/ });
  await assert.rejects(openai.synthesize('hi', 'openai:zzzz', OPENAI_ENV, err(400, { param: 'voice', message: "'zzzz' is not one of ..." })), { status: 400, message: /No such OpenAI voice/ });
  await assert.rejects(openai.synthesize('hi', 'openai:alloy', OPENAI_ENV, { fetchImpl: async () => new Response(new Uint8Array(0)) }), { status: 502, message: /no audio/ });
});
