// Is Microsoft's voice service still answering the engine? Lists the voices and synthesizes
// one short phrase, straight from Node (the desktop app's path, same token and protocol code
// as the extension) and through the deployed Worker. Exit code 1 when anything fails.
// CI runs this on a schedule (.github/workflows/edge-health.yml) and opens an issue on failure.
//   node scripts/edge-health.mjs                       direct + Worker (DAN_TTS_WORKER or the default)
//   DAN_TTS_WORKER= node scripts/edge-health.mjs       direct only
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { synthesize, connectionHeaders, listVoices } = await import(join(root, 'engine/src/tts.js'));
const PHRASE = 'The quick brown fox jumps over the lazy dog.';
const VOICE = 'en-US-AriaNeural';
const worker = (process.env.DAN_TTS_WORKER ?? 'https://dan-tts.macdaddydwj.workers.dev').replace(/\/$/, '');

const results = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${Date.now() - t0} ms${detail ? ', ' + detail : ''})`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}  (${Date.now() - t0} ms): ${err.message}`);
  }
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms).unref())]);

// ---- Straight to Microsoft, with the engine ----
await check('voice list (direct)', async () => {
  const voices = await withTimeout(listVoices({ headers: connectionHeaders() }), 20000, 'voice list');
  if (!Array.isArray(voices) || voices.length < 100) throw new Error(`only ${voices?.length} voices returned`);
  if (!voices.some((v) => v.ShortName === VOICE)) throw new Error(`${VOICE} is missing from the list`);
  return `${voices.length} voices`;
});
await check('synthesis (direct)', async () => {
  const openSocket = (url) => new WebSocket(url, { headers: connectionHeaders() });
  const { audio, boundaries } = await synthesize(PHRASE, { voice: VOICE, openSocket, timeoutMs: 30000 });
  if (audio.length < 2000) throw new Error(`only ${audio.length} bytes of audio`);
  if (boundaries.length < 5) throw new Error(`only ${boundaries.length} word boundaries`);
  return `${audio.length} bytes, ${boundaries.length} words`;
});

// ---- Through the deployed Worker (the tester's and the website's path) ----
if (worker) {
  const fetchJson = async (path, init) => {
    const res = await fetch(`${worker}${path}`, { ...init, signal: AbortSignal.timeout(30000) });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}: ${body.slice(0, 200)}`);
    try { return JSON.parse(body); } catch { throw new Error(`${path} did not return JSON: ${body.slice(0, 120)}`); }
  };
  let providers = ['edge'];
  await check(`health (${worker})`, async () => {
    const h = await fetchJson('/health');
    if (h.status !== 'ok') throw new Error(JSON.stringify(h));
    providers = h.providers || providers;
    return `${h.runtime}, providers: ${providers.join(', ')}`;
  });
  await check('voice list (Worker)', async () => {
    const voices = await fetchJson('/voices');
    if (!voices.some((v) => v.shortName === VOICE)) throw new Error(`${VOICE} is missing (${voices.length} voices)`);
    const summary = [`${voices.filter((v) => (v.provider || 'edge') === 'edge').length} en-US Edge voices`];
    // Listing a provider's voices costs nothing, so every configured provider must show up
    for (const p of providers.filter((p) => p !== 'edge')) {
      const n = voices.filter((v) => v.provider === p).length;
      if (!n) throw new Error(`${p} is configured but returned no voices (key rejected or service down?)`);
      summary.push(`${n} ${p} voices`);
    }
    return summary.join(', ');
  });
  if (providers.includes('elevenlabs')) {
    // Informational: a provider hiccup here must not raise the Edge alert (a rejected key already fails the voice-list check)
    await check('ElevenLabs credits (Worker /usage)', async () => {
      const u = (await fetchJson('/usage')).elevenlabs;
      if (!u) throw new Error('no usage reported');
      if (u.error) return `not available right now (${u.error})`;
      return `${u.remaining} of ${u.limit} credits left${u.resetsAt ? `, resets ${u.resetsAt.slice(0, 10)}` : ''}`;
    });
  }
  await check('synthesis with timings (Worker)', async () => {
    const r = await fetchJson('/synthesize_with_timing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: PHRASE, voice: VOICE, format: 'mp3' }) });
    const bytes = Buffer.from(r.audio || '', 'base64').length;
    if (bytes < 2000) throw new Error(`only ${bytes} bytes of audio`);
    if (!r.boundaries || r.boundaries.length < 5) throw new Error(`only ${r.boundaries?.length} word boundaries`);
    return `${bytes} bytes, ${r.boundaries.length} words`;
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nIf every direct check fails, Microsoft probably changed the endpoint or the token scheme: compare engine/src/drm.js and engine/src/tts.js with the latest edge-tts (https://github.com/rany2/edge-tts). If only the Worker checks fail, see worker/README.md.');
  process.exit(1);
}
