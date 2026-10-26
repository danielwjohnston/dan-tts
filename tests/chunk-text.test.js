// Run with: node --test tests/chunk-text.test.js
const test = require('node:test');
const assert = require('node:assert');
const { chunkText } = require('../static/chunk-text.js');

const squash = s => s.replace(/\s+/g, ' ').trim();

test('short text stays a single chunk', () => {
  assert.deepStrictEqual(chunkText('Hello world.'), ['Hello world.']);
});

test('blank input yields no chunks', () => {
  assert.deepStrictEqual(chunkText('   \n\n  '), []);
});

test('splits on paragraphs and keeps every word', () => {
  const text = Array.from({ length: 6 }, (_, i) => `Para ${i}. ` + 'Filler sentence here. '.repeat(40)).join('\n\n');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  assert.strictEqual(squash(chunks.join(' ')), squash(text));
});

test('merges short paragraphs up to the target size', () => {
  const chunks = chunkText(Array(10).fill('Tiny paragraph.').join('\n\n'), { target: 60 });
  assert.ok(chunks.length < 10);
  chunks.forEach(c => assert.ok(c.length <= 60));
});

test('oversized paragraphs split at sentence ends within max', () => {
  const chunks = chunkText('A sentence here. '.repeat(400), { max: 3000 });
  assert.ok(chunks.length >= 3);
  chunks.forEach(c => { assert.ok(c.length <= 3000); assert.ok(c.endsWith('.')); });
});

test('run-on text without punctuation still respects max', () => {
  const chunks = chunkText('word '.repeat(2000), { max: 3000 });
  chunks.forEach(c => assert.ok(c.length <= 3000));
  assert.strictEqual(squash(chunks.join(' ')), squash('word '.repeat(2000)));
});

test('a dot between digits is not a sentence end, so break tags and decimals stay whole', () => {
  const sentence = 'The road climbs for a while and the sheep watch with mild interest. ';
  const para = Array.from({ length: 60 }, (_, i) => (i % 6 === 5 ? sentence + '<break time="1.5s" /> ' : sentence)).join('');
  const chunks = chunkText(para);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.strictEqual((c.match(/<break/g) || []).length, (c.match(/\/>/g) || []).length, c.slice(-60));
  assert.deepStrictEqual(chunkText('It cost 3.50 today. ' .repeat(200), { max: 100, target: 50 }).every((c) => !/^50/.test(c)), true);
});
