// Run with: node --test tests/bundle.test.js
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { boundariesToSrt, crc32, makeZip, splitBatch, srtTime } = require('../static/bundle.js');

test('srtTime formats hours, minutes, seconds and millis', () => {
  assert.strictEqual(srtTime(3723004), '01:02:03,004');
  assert.strictEqual(srtTime(0), '00:00:00,000');
});

test('boundariesToSrt matches the server format', () => {
  const srt = boundariesToSrt([{ offset: 500000, duration: 3000000, text: 'Hello' }, { offset: 4000000, duration: 8500000, text: 'world' }]);
  assert.strictEqual(srt, '1\n00:00:00,050 --> 00:00:00,350\nHello\n\n2\n00:00:00,400 --> 00:00:01,250\nworld\n');
});

test('crc32 matches zlib', () => {
  const data = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
  assert.strictEqual(crc32(data), zlib.crc32(data));
});

test('makeZip produces an archive that Python and the zip format accept', () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 254]);
  const zip = makeZip([{ name: '01-hello.mp3', data: bytes }, { name: '01-hello.srt', data: 'Ünïcode ✓' }, { name: 'empty.txt', data: '' }]);
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const file = join(dir, 'out.zip');
  writeFileSync(file, zip);
  const out = execFileSync('python3', ['-c', `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename: list(z.read(i.filename)) for i in z.infolist()}))`, file]).toString();
  const files = JSON.parse(out);
  assert.deepStrictEqual(Object.keys(files), ['01-hello.mp3', '01-hello.srt', 'empty.txt']);
  assert.deepStrictEqual(files['01-hello.mp3'], [0, 1, 2, 255, 254]);
  assert.strictEqual(Buffer.from(files['01-hello.srt']).toString(), 'Ünïcode ✓');
});

test('splitBatch splits on --- lines only', () => {
  assert.deepStrictEqual(splitBatch('First item.\n\nStill first.\n---\nSecond -- not a split\n  ---  \n\n---\nThird'), ['First item.\n\nStill first.', 'Second -- not a split', 'Third']);
  assert.deepStrictEqual(splitBatch('   '), []);
});
