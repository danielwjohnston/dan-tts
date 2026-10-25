// Load from URL on the Worker, offline: the HTML → text rules and the fetch rules.
import test from 'node:test';
import assert from 'node:assert';
import { htmlToText, extractText, decodeEntities, HttpError, MAX_FETCH_BYTES } from '../src/extract.js';

const page = (body, head = '') => `<!doctype html><html><head><title>Example Page</title>${head}</head><body>${body}</body></html>`;
const story = '<p>The story begins on a dark and stormy night. '.repeat(1) + 'The story begins on a dark and stormy night. '.repeat(3) + '</p><p>It continues the next morning in the same town.</p>';

test('reads <main> and drops scripts, styles, nav, header and footer', () => {
  const html = page(`<header><p>Site name Log in</p></header><nav><a href="/">Home</a> <a href="/a">About</a></nav>
    <main><h1>Title</h1>${story}<script>var x = "<p>not text</p>";</script><style>p { color: red }</style></main>
    <footer><p>Copyright</p></footer>`);
  const { title, text } = htmlToText(html);
  assert.strictEqual(title, 'Example Page');
  assert.match(text, /^Title\n\nThe story begins/);
  assert.match(text, /next morning/);
  for (const bad of ['Log in', 'Home', 'About', 'not text', 'color', 'Copyright']) assert.ok(!text.includes(bad), `should not contain ${bad}: ${text}`);
});

test('without <main> or <article>, sidebars, menus and boxes are skipped and the body is read', () => {
  const html = page(`<div class='site-header'><p>Wikisource Log in Donate</p></div>
    <div class='sidebar-menu'><p>Navigation links for the sidebar here</p></div>
    <div role="navigation"><a href="#">Previous</a></div><aside><p>Related reading</p></aside>
    <div id='content'>${story}</div>
    <div id="comments"><p>First! Great post.</p></div>`);
  const { text } = htmlToText(html);
  assert.match(text, /dark and stormy night/);
  assert.match(text, /next morning/);
  for (const bad of ['Log in', 'sidebar', 'Previous', 'Related', 'First!']) assert.ok(!text.includes(bad), `should not contain ${bad}: ${text}`);
});

test('MediaWiki chrome, hidden elements and buttons inside <main> are skipped', () => {
  const html = page(`<main><div id="siteSub" class="noprint">From Wikisource</div>
    <div class="ws-header wst-header ws-noexport noprint"><div>←</div><a href="/toc">Contents</a><span>Chapter 2</span><div>→</div></div>
    <span role="button" class="oo-ui-buttonElement-button">Download</span>
    <div class="hatnote" role="note">For other uses, see Library (disambiguation).</div>
    <p hidden>Hidden paragraph text</p><p aria-hidden="true">Decorative text</p><p style="display:none">Invisible text</p>
    <span class="sr-only">Skip to content</span>
    <h2>Chapter one <span class="mw-editsection">[edit]</span></h2>
    ${story}
    <div id="catlinks" class="catlinks"><a href="#">Category: Novels</a></div></main>`);
  const { text } = htmlToText(html);
  assert.match(text, /^Chapter one\n\nThe story begins/);
  for (const bad of ['Wikisource', 'Contents', '→', 'Download', 'other uses', 'Hidden', 'Decorative', 'Invisible', 'Skip', 'edit', 'Category']) assert.ok(!text.includes(bad), `should not contain ${bad}: ${text}`);
});

test('<article> is read when there is no <main>; the first one wins', () => {
  const html = page(`<div class="promo"><p>Buy now</p></div><article><p>One two three four five six.</p></article><article><p>Second article text here.</p></article>`);
  const { text } = htmlToText(html);
  assert.strictEqual(text, 'One two three four five six.');
});

test('paragraphs become blank-line separated text; inline tags keep their spaces', () => {
  const html = page(`<div><p>Hello <b>bold</b> and <i>italic</i>, with a<br>line break.</p>
    <h2>Heading</h2><ul><li>First item</li><li>Second item</li></ul>
    <p>Spaced&nbsp;words &amp; entities: &ldquo;quoted&rdquo; &eacute; &#8212; &#x2014; &#146;</p></div>`);
  const { text } = htmlToText(html);
  assert.strictEqual(text, 'Hello bold and italic, with a\nline break.\n\nHeading\n\nFirst item\n\nSecond item\n\nSpaced words & entities: “quoted” é — — ’');
});

test('tolerates unclosed tags, attributes with > inside quotes, comments and stray <', () => {
  const html = `<html><body><div class="a" data-x="1 > 0"><p>Alpha beta gamma delta <!-- <p>hidden</p> --> epsilon
    <p>Second paragraph 2 < 3 and more words here<div class=unquoted>Tail words after.</body></html>`;
  const { text } = htmlToText(html);
  assert.match(text, /^Alpha beta gamma delta epsilon/);
  assert.ok(!text.includes('hidden'));
  assert.match(text, /Second paragraph 2 < 3 and more words here/);
  assert.match(text, /Tail words after\./);
});

test('meta descriptions are collected in priority order; title decodes entities', () => {
  const html = page('<div id="root"></div>', '<meta name="description" content="Plain &amp; simple"><meta property="og:description" content="News before it trends">');
  const r = htmlToText(html);
  assert.strictEqual(r.description, 'News before it trends');
  assert.strictEqual(htmlToText('<title>A &amp; B &mdash; C</title><body><p>x</p></body>').title, 'A & B — C');
});

test('decodeEntities leaves unknown and unterminated names alone', () => {
  assert.strictEqual(decodeEntities('AT&T &unknown; &amp &#9999999; &#xD800;'), 'AT&T &unknown; &amp � �');
});

// ---- fetching ----
const html = (body, init = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });
const story20 = page('<main><p>' + 'word '.repeat(20) + '</p></main>');
const fake = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(url); return handler(url, init, calls.length); };
  return { fetchImpl, calls };
};
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof HttpError && e.status === status && (!re || re.test(e.message)) || (() => { throw e; })());

test('fetches a page and returns text, title and chars', async () => {
  const { fetchImpl, calls } = fake(() => html(story20));
  const r = await extractText('https://example.com/story', { fetchImpl });
  assert.deepStrictEqual(r, { text: 'word '.repeat(20).trim(), title: 'Example Page', chars: 99 });
  assert.deepStrictEqual(calls, ['https://example.com/story']);
});

test('bare domain tries https then http, and returns the last error when both fail', async () => {
  const { fetchImpl, calls } = fake((url) => (url.startsWith('https://') ? html('', { status: 500 }) : html(story20)));
  assert.strictEqual((await extractText('example.com', { fetchImpl })).title, 'Example Page');
  assert.deepStrictEqual(calls, ['https://example.com/', 'http://example.com/']);
  await rejects(extractText('nope.example', { fetchImpl: async () => html('', { status: 404 }) }), 502, /HTTP 404/);
});

test('follows redirects one hop at a time, relative ones too, up to a limit', async () => {
  const { fetchImpl, calls } = fake((url, init) => {
    assert.strictEqual(init.redirect, 'manual');
    if (url === 'https://example.com/a') return new Response(null, { status: 301, headers: { location: '/b' } });
    if (url === 'https://example.com/b') return new Response(null, { status: 302, headers: { location: 'https://example.com/c' } });
    return html(story20);
  });
  await extractText('https://example.com/a', { fetchImpl });
  assert.deepStrictEqual(calls, ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
  const loop = async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } });
  await rejects(extractText('https://example.com/loop', { fetchImpl: loop }), 502, /Too many redirects/);
  // A redirect into a private address is refused on that hop
  const inward = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  await rejects(extractText('https://example.com/x', { fetchImpl: inward }), 400, /not allowed/);
});

test('blocked, failing, oversized and slow sites get the same messages as the Python server', async () => {
  await rejects(extractText('https://example.com/', { fetchImpl: async () => html('', { status: 403 }) }), 502, /example\.com blocked automated access \(HTTP 403\)\. Open the page in your browser/);
  await rejects(extractText('https://example.com/', { fetchImpl: async () => html('', { status: 500 }) }), 502, /^URL returned HTTP 500$/);
  await rejects(extractText('https://example.com/', { fetchImpl: async () => html('x'.repeat(MAX_FETCH_BYTES + 1)) }), 413, /too large/);
  await rejects(extractText('https://example.com/', { fetchImpl: async () => html('', { headers: { 'content-length': String(MAX_FETCH_BYTES + 1) } }) }), 413, /too large/);
  await rejects(extractText('https://example.com/', { fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); } }), 504, /timed out/);
  await rejects(extractText('https://example.com/', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), 502, /Failed to fetch URL: fetch failed/);
});

test('private and local addresses, and other schemes, are refused', async () => {
  const never = async () => { throw new Error('should not fetch'); };
  for (const url of ['http://127.0.0.1/', 'http://localhost/x', 'http://app.localhost/', 'http://10.0.0.5/', 'http://169.254.169.254/latest', 'http://192.168.1.1/',
    'http://172.20.0.1/', 'http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:10.0.0.1]/', 'http://2130706433/', 'http://0.0.0.0/']) {
    await rejects(extractText(url, { fetchImpl: never }), 400, /not allowed/);
  }
  await rejects(extractText('ftp://example.com/', { fetchImpl: never }), 400, /Only http/);
  await rejects(extractText('   ', { fetchImpl: never }), 400, /required/);
});

test('JavaScript-only pages fall back to the meta description, else 422', async () => {
  const spa = page('<div id="root"></div>', '<meta property="og:description" content="News before it trends">').replace('Example Page', 'Digg');
  assert.strictEqual((await extractText('digg.com', { fetchImpl: async () => html(spa) })).text, 'Digg\n\nNews before it trends');
  await rejects(extractText('spa.example', { fetchImpl: async () => html(page('<div id="root"></div>')) }), 422, /rendered with JavaScript/);
});

test('decodes the charset from the Content-Type header or a <meta charset>', async () => {
  const latin = new Uint8Array([...new TextEncoder().encode('<main><p>caf'), 0xe9, ...new TextEncoder().encode(' au lait is a drink with milk</p></main>')]);
  const r1 = await extractText('https://example.com/', { fetchImpl: async () => new Response(latin, { headers: { 'content-type': 'text/html; charset=iso-8859-1' } }) });
  assert.match(r1.text, /^café au lait/);
  const sniffed = new Uint8Array([...new TextEncoder().encode('<html><head><meta charset="windows-1252"></head><body><main><p>caf'), 0xe9, ...new TextEncoder().encode(' au lait is a drink with milk</p></main>')]);
  const r2 = await extractText('https://example.com/', { fetchImpl: async () => new Response(sniffed, { headers: { 'content-type': 'text/html' } }) });
  assert.match(r2.text, /^café au lait/);
});
