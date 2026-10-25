// The Worker's routing, offline: requests go through the same fetch handler as in production.
import test from 'node:test';
import assert from 'node:assert';
import worker from '../src/index.js';

const ctx = { waitUntil() {} };
const call = (path, init) => worker.fetch(new Request(`https://dan-tts.example${path}`, init), {}, ctx);
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health and CORS', async () => {
  const res = await call('/health');
  assert.deepStrictEqual(await res.json(), { status: 'ok', runtime: 'cloudflare-worker' });
  assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
  assert.strictEqual((await call('/synthesize', { method: 'OPTIONS' })).status, 200);
  assert.strictEqual((await call('/nope')).status, 404);
});

test('/extract_text reads a page through the Worker', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.strictEqual(url, 'https://example.com/story');
    return new Response('<html><head><title>Story</title></head><body><nav>Menu</nav><main><p>' + 'word '.repeat(10) + '</p></main></body></html>', { headers: { 'content-type': 'text/html' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const res = await post('/extract_text', { url: 'https://example.com/story' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { text: 'word '.repeat(10).trim(), title: 'Story', chars: 49 });
});

test('/extract_text validation errors look like the Python server\'s', async () => {
  assert.deepStrictEqual([(await post('/extract_text', {})).status, (await post('/extract_text', { url: 'ftp://x' })).status, (await post('/extract_text', { url: 'http://localhost/' })).status], [400, 400, 400]);
  assert.match((await post('/extract_text', { url: 'http://localhost/' }).then((r) => r.json())).detail, /not allowed/);
  const bad = await call('/extract_text', { method: 'POST', body: 'not json' });
  assert.strictEqual(bad.status, 400);
});

test('synthesis requests are validated before any network use', async () => {
  assert.strictEqual((await post('/synthesize', { text: '' })).status, 400);
  assert.strictEqual((await post('/synthesize', { text: 'hi', voice: 'bad voice' })).status, 400);
  assert.strictEqual((await post('/synthesize', { text: 'hi', format: 'ogg' })).status, 400);
  assert.strictEqual((await post('/synthesize', { text: 'x'.repeat(20001) })).status, 422);
});
