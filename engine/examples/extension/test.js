import { synthesize } from './engine/tts.js'; // copy engine/src/*.js into ./engine/ before loading;
const openSocket = (url) => new WebSocket(url);
async function attempt(label) {
  const t0 = performance.now();
  try {
    const r = await synthesize('Hello from inside a browser extension, with no server at all.', { openSocket, timeoutMs: 20000 });
    return { label, ok: true, ms: Math.round(performance.now() - t0), bytes: r.audio.length, words: r.boundaries.length, first: r.boundaries[0] };
  } catch (e) { return { label, ok: false, error: e.message }; }
}
window.runSpike = async () => {
  await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['edge'] });
  const off = await attempt('rules OFF (control)');
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['edge'] });
  const on = await attempt('rules ON');
  return [off, on];
};
