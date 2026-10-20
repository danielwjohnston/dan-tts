const test = require('node:test');
const assert = require('node:assert');
const { itemsToLines, pagesToBlocks } = require('../lib/pdf-text.js');

// A pdf.js-style text item: transform = [a, b, c, d, x, y]
const item = (str, x, y, { size = 12, width = str.length * size * 0.5, eol = true, rotated = false } = {}) =>
  ({ str, transform: rotated ? [0, size, -size, 0, x, y] : [size, 0, 0, size, x, y], width, height: size, hasEOL: eol });

// A page of body lines starting at y=700, 14pt apart, with an optional header/footer
function page(lines, { header, footer, start = 700 } = {}) {
  const items = [];
  if (header) items.push(item(header, 200, 760, { size: 9 }));
  lines.forEach((t, i) => items.push(item(t, 72, start - i * 14, { width: t.length * 6 })));
  if (footer) items.push(item(footer, 300, 40, { size: 9 }));
  return items;
}
const LONG = 'The library on Elm Street had tall windows and creaking floors and quiet corners';

test('items on the same baseline join into one line, with spaces where there are gaps', () => {
  const lines = itemsToLines([item('Hello', 72, 700, { eol: false, width: 30 }), item('world', 110, 700, { width: 30 }), item('Next', 72, 686)]);
  assert.deepStrictEqual(lines.map((l) => l.text), ['Hello world', 'Next']);
});

test('rotated text (margin stamps, watermarks) is ignored', () => {
  assert.deepStrictEqual(itemsToLines([item('arXiv:1706.03762', 20, 400, { rotated: true }), item('Body', 72, 700)]).map((l) => l.text), ['Body']);
});

test('running headers and page numbers are removed', () => {
  const pages = [1, 2, 3].map((n) => page([LONG, LONG + '.'], { header: 'The Quiet Library — A Novel', footer: String(n) }));
  const text = pagesToBlocks(pages).map((b) => b.text).join(' ');
  assert.ok(!/A Novel/.test(text));
  assert.ok(!/\b[123]\b/.test(text));
});

test('words hyphenated across a line break are rejoined', () => {
  const blocks = pagesToBlocks([page(['It was an extra-', 'ordinary day at the library on Elm Street with its tall windows.'])]);
  assert.strictEqual(blocks[0].text, 'It was an extraordinary day at the library on Elm Street with its tall windows.');
});

test('vertical gaps and short sentence-ending lines start new paragraphs', () => {
  const items = [...page([LONG, 'and it was lovely.']), ...page([LONG, LONG + '.'], { start: 640 })];
  const blocks = pagesToBlocks([items]);
  assert.strictEqual(blocks.length, 2);
  assert.ok(blocks[0].text.endsWith('lovely.') && blocks[1].text.startsWith('The library'));
});

test('large text becomes a heading', () => {
  const items = [item('Chapter One', 72, 740, { size: 24 }), ...page([LONG, LONG + '.'])];
  const blocks = pagesToBlocks([items]);
  assert.deepStrictEqual(blocks.map((b) => b.tag), ['h', 'p']);
  assert.strictEqual(blocks[0].text, 'Chapter One');
});

test('a paragraph continues across a page break', () => {
  const blocks = pagesToBlocks([page([LONG, LONG]), page([LONG + '.'])]);
  assert.strictEqual(blocks.length, 1);
});

test('empty input yields no blocks', () => {
  assert.deepStrictEqual(pagesToBlocks([[], []]), []);
});
