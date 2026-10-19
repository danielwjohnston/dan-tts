import { synthesize, connectionHeaders } from '../../../src/tts.js';

// Cloudflare's outbound WebSocket: fetch() with Upgrade, then accept(). Wrap it in the
// minimal browser-style interface the engine expects.
async function openSocket(url) {
  const resp = await fetch(url.replace('wss://', 'https://'), { headers: { Upgrade: 'websocket', ...connectionHeaders() } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`Upgrade refused: HTTP ${resp.status}`);
  ws.binaryType = 'arraybuffer'; // default here is Blob
  ws.accept();
  const sock = { readyState: 1, binaryType: 'arraybuffer', send: (d) => ws.send(d), close: () => ws.close() };
  ws.addEventListener('message', (e) => sock.onmessage?.(e));
  ws.addEventListener('close', (e) => sock.onclose?.(e));
  ws.addEventListener('error', (e) => sock.onerror?.(e));
  return sock;
}

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('POST {text, voice}', { status: 405, headers: cors });
    const { text, voice } = await request.json();
    const t0 = Date.now();
    const { audio, boundaries } = await synthesize(text, { voice, openSocket });
    return Response.json({ audio: b64(audio), contentType: 'audio/mpeg', boundaries, ms: Date.now() - t0 }, { headers: cors });
  },
};
