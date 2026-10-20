const test = require('node:test');
const assert = require('node:assert');
const { alignBoundaries } = require('../lib/align.js');

const toks = (s) => s.split(/\s+/).filter(Boolean).map((text) => ({ text }));
const b = (...words) => words.map((text) => ({ text }));

test('exact words map one-to-one, ignoring punctuation', () => {
  const r = alignBoundaries(b('Hello', 'world', 'again'), toks('Hello, world! Again.'), 0);
  assert.deepStrictEqual(r.map, [0, 1, 2]);
  assert.strictEqual(r.next, 3);
});

test('a boundary covering part of a token keeps the cursor on it', () => {
  const r = alignBoundaries(b('dan', 'tts', 'rocks'), toks('dan-tts rocks'), 0);
  assert.deepStrictEqual(r.map, [0, 0, 1]);
});

test('one boundary spanning a hyphenated token', () => {
  const r = alignBoundaries(b('state-of-the-art', 'voices'), toks('state-of-the-art voices'), 0);
  assert.deepStrictEqual(r.map, [0, 1]);
});

test('skips tokens the voice did not speak (e.g. bullets, symbols)', () => {
  const r = alignBoundaries(b('first', 'second'), toks('• first — second'), 0);
  assert.deepStrictEqual(r.map, [1, 3]);
});

test('unmatched boundaries return -1 and do not move the cursor', () => {
  const r = alignBoundaries(b('one', 'zzz', 'two'), toks('one two'), 0);
  assert.deepStrictEqual(r.map, [0, -1, 1]);
});

test('starts from an approximate offset and continues across chunks', () => {
  const tokens = toks('a b c d e f g');
  const first = alignBoundaries(b('a', 'b', 'c'), tokens, 0);
  const second = alignBoundaries(b('d', 'e'), tokens, first.next);
  assert.deepStrictEqual(second.map, [3, 4]);
  // An estimate one token early still finds the right words
  assert.deepStrictEqual(alignBoundaries(b('e', 'f'), tokens, 3).map, [4, 5]);
});
