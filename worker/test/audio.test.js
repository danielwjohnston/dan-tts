// The shared provider helpers, offline: synthetic MP3 frames, estimated timings, pieces, SSML.
import test from 'node:test';
import assert from 'node:assert';
import { mp3Frames, mp3Ticks, joinPieces, estimateBoundaries, pieces, ssmlBody, ssmlWithMarks, hasBreaks, localesOf, localeOk } from '../src/audio.js';
import { mp3 } from './helpers.js';

test('mp3Frames measures MPEG-2 and MPEG-1 frames and skips ID3 tags', () => {
  assert.strictEqual(mp3Ticks(mp3(10)), 2_400_000); // 10 × 24 ms
  const tagged = mp3Frames(mp3(10, { id3: true, tag: true }));
  assert.strictEqual(tagged.ticks, 2_400_000);
  assert.strictEqual(tagged.frames.length, 1440, 'tags are dropped, frames kept');
  assert.deepStrictEqual(Array.from(tagged.frames.subarray(0, 4)), [0xff, 0xf3, 0x64, 0xc0]);
  // MPEG-1 Layer III, 44.1 kHz, 128 kbps: 417-byte frames of 1152 samples
  const f = new Uint8Array(417 * 3); for (let i = 0; i < 3; i++) f.set([0xff, 0xfb, 0x90, 0xc0], i * 417);
  assert.strictEqual(mp3Ticks(f), 3 * 261224);
  assert.deepStrictEqual(mp3Frames(new Uint8Array([1, 2, 3, 0xff, 0xfb])), { frames: new Uint8Array(0), ticks: 0 });
  assert.strictEqual(mp3Ticks(new TextEncoder().encode('not audio at all, really')), 0);
});

test('joinPieces concatenates frames and shifts later boundaries by the audio before them', () => {
  const a = { audio: mp3(10, { id3: true }), boundaries: [{ offset: 0, duration: 1_000_000, text: 'One' }] };
  const b = { audio: mp3(5), boundaries: [{ offset: 100_000, duration: 500_000, text: 'two' }] };
  const joined = joinPieces([a, b]);
  assert.strictEqual(joined.ticks, 3_600_000);
  assert.strictEqual(joined.audio.length, 15 * 144);
  assert.deepStrictEqual(joined.boundaries, [{ offset: 0, duration: 1_000_000, text: 'One' }, { offset: 2_500_000, duration: 500_000, text: 'two' }]);
  // One piece passes through untouched (its ID3 tag included)
  const one = joinPieces([a]);
  assert.strictEqual(one.audio, a.audio);
  assert.strictEqual(one.ticks, 2_400_000);
});

test('estimateBoundaries spreads the clip over the words by their length, with pauses at punctuation', () => {
  const b = estimateBoundaries('Hi there, world.', 10_000_000);
  // weights: Hi 3, there 6 + 1.5 pause, world 6 + 3 pause → 19.5
  assert.deepStrictEqual(b.map((x) => x.text), ['Hi', 'there,', 'world.']);
  assert.deepStrictEqual(b[0], { offset: 0, duration: Math.floor(10_000_000 * 3 / 19.5), text: 'Hi' });
  assert.strictEqual(b[1].offset, Math.floor(10_000_000 * 3 / 19.5));
  assert.strictEqual(b[2].offset, Math.floor(10_000_000 * 10.5 / 19.5));
  assert.strictEqual(b[2].offset + b[2].duration, Math.floor(10_000_000 * 16.5 / 19.5));
  assert.deepStrictEqual(estimateBoundaries('  ', 5), []);
  assert.deepStrictEqual(estimateBoundaries('Hi', 0), []);
  assert.strictEqual(estimateBoundaries('café —', 1000)[1].text, '—'); // a lone dash is still a word of weight 2
});

test('pieces keeps paragraphs whole when they fit, splits at sentences, never inside a break tag', () => {
  assert.deepStrictEqual(pieces('One.\n\nTwo.', 100), ['One.\n\nTwo.']);
  assert.deepStrictEqual(pieces('One.\n\nTwo.', 6), ['One.', 'Two.']);
  const long = 'A sentence here. '.repeat(50);
  const out = pieces(long, 100);
  assert.ok(out.length >= 8);
  out.forEach((p) => { assert.ok(p.length <= 100); assert.ok(p.endsWith('.')); });
  assert.strictEqual(out.join(' ').replace(/\s+/g, ' '), long.trim());
  const runOn = 'word '.repeat(60) + '<break time="1.5s" /> ' + 'word '.repeat(60);
  const cut = pieces(runOn, 70);
  cut.forEach((p) => { assert.ok(p.length <= 70); assert.strictEqual((p.match(/<break/g) || []).length, (p.match(/\/>/g) || []).length, p); });
  assert.deepStrictEqual(pieces('   \n\n ', 10), []);
});

test('ssmlBody escapes text but keeps (and caps) break tags; ssmlWithMarks numbers every word', () => {
  assert.strictEqual(ssmlBody('Tom & Jerry <b>', { maxMs: 3000 }), 'Tom &amp; Jerry &lt;b&gt;');
  assert.strictEqual(ssmlBody('Wait <break time="0.4s" /> here <break time="9s"/>', { maxMs: 3000 }), 'Wait <break time="400ms"/> here <break time="3000ms"/>');
  assert.strictEqual(ssmlBody('a\u000Bb'), 'a b');
  assert.ok(hasBreaks('x <break time="1s"/> y') && !hasBreaks('x < y'));
  const { body, words } = ssmlWithMarks('Hi there, <break time="0.4s" /> "you" & me');
  assert.deepStrictEqual(words, ['Hi', 'there,', '"you"', '&', 'me']);
  assert.strictEqual(body, '<mark name="0"/>Hi <mark name="1"/>there, <break time="400ms"/> <mark name="2"/>&quot;you&quot; <mark name="3"/>&amp; <mark name="4"/>me');
});

test('VOICE_LOCALES picks the locales a provider lists', () => {
  assert.deepStrictEqual(localesOf({}), ['en-US']);
  assert.deepStrictEqual(localesOf({ VOICE_LOCALES: 'en-GB, de-DE' }), ['en-GB', 'de-DE']);
  assert.deepStrictEqual(localesOf({ VOICE_LOCALES: '*' }), []);
  assert.ok(localeOk(['en-US'], 'en-us') && !localeOk(['en-US'], 'de-DE') && localeOk([], 'xx-XX'));
});
