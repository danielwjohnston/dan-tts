// Stand-in for the chrome.* extension APIs, so the extension's reader code (content.js,
// offscreen.js, pdf-reader.js) runs unchanged in the desktop window. Loaded first on every page.
(() => {
  const ROOT = 'app://reader/';
  const listeners = [];
  const deliver = (msg) => setTimeout(() => listeners.forEach((fn) => { try { fn(msg, {}, () => {}); } catch (e) { console.error(e); } }), 0);

  // ---- player: offscreen.js runs in this window, events go straight to the reader ----
  let player = null;
  const getPlayer = () => (player ??= import(ROOT + 'offscreen.js').then((m) => { m.setEventSink(async (msg) => deliver(msg)); return m; }));

  // ---- voices (cached a day, like the extension) ----
  async function voices() {
    try {
      const cached = JSON.parse(localStorage.getItem('dan.voiceCache') || 'null');
      if (cached && Date.now() - cached.at < 86400000) return cached.voices;
    } catch {}
    const { listVoices } = await import(ROOT + 'engine/tts.js');
    const list = (await listVoices()).map(({ ShortName, Locale, LocaleName, Gender, FriendlyName }) => ({ ShortName, Locale, LocaleName, Gender, FriendlyName }));
    localStorage.setItem('dan.voiceCache', JSON.stringify({ at: Date.now(), voices: list }));
    return list;
  }

  async function sendMessage(msg) {
    if (msg?.target === 'player') { (await getPlayer()).handleCommand(msg); return { ok: true }; }
    if (msg?.target === 'background' && msg.cmd === 'voices') return { voices: await voices() };
    if (msg?.target === 'background') return { ok: true }; // keepalive and similar: nothing to do here
    return undefined;
  }

  // ---- storage: localStorage, one JSON value per key ----
  const changeListeners = [];
  function area(name) {
    const k = (key) => `chrome.${name}.${key}`;
    const read = (key) => { const v = localStorage.getItem(k(key)); return v === null ? undefined : JSON.parse(v); };
    const allKeys = () => Object.keys(localStorage).filter((x) => x.startsWith(`chrome.${name}.`)).map((x) => x.slice(`chrome.${name}.`.length));
    const notify = (changes) => { if (Object.keys(changes).length) changeListeners.forEach((fn) => fn(changes, name)); };
    return {
      async get(keys) {
        const out = {};
        if (keys == null) { for (const key of allKeys()) out[key] = read(key); return out; }
        const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        for (const key of list) {
          const v = read(key);
          if (v !== undefined) out[key] = v;
          else if (keys && typeof keys === 'object' && !Array.isArray(keys)) out[key] = keys[key];
        }
        return out;
      },
      async set(items) {
        const changes = {};
        for (const [key, value] of Object.entries(items)) { changes[key] = { oldValue: read(key), newValue: value }; localStorage.setItem(k(key), JSON.stringify(value)); }
        notify(changes);
      },
      async remove(keys) {
        const changes = {};
        for (const key of [].concat(keys)) { changes[key] = { oldValue: read(key) }; localStorage.removeItem(k(key)); }
        notify(changes);
      },
    };
  }
  // Other windows/pages of the app see changes through the storage event
  addEventListener('storage', (e) => {
    const m = e.key && e.key.match(/^chrome\.(sync|local)\.(.*)$/);
    if (m) changeListeners.forEach((fn) => fn({ [m[2]]: { oldValue: e.oldValue && JSON.parse(e.oldValue), newValue: e.newValue && JSON.parse(e.newValue) } }, m[1]));
  });

  window.chrome = {
    runtime: {
      id: 'dan-tts-desktop',
      getURL: (p) => new URL(p, ROOT).href,
      sendMessage,
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: (fn) => changeListeners.push(fn) } },
    permissions: { request: async () => true },
  };

  // Downloads of other sites go through the main process (pages can't fetch cross-site);
  // the voice service and the app's own files use the normal fetch.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (/^https?:/i.test(url) && !/^https:\/\/(speech\.platform\.bing\.com|cdn\.jsdelivr\.net)\//.test(url) && (!init || !init.method || init.method === 'GET')) {
      let r;
      try {
        r = await window.danDesktop.fetch(url);
      } catch (err) {
        // Like a browser's fetch: a network failure is a TypeError, with a readable message
        // instead of "Error invoking remote method 'dan:fetch': Error: net::ERR_TIMED_OUT"
        const raw = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        const why = { ERR_TIMED_OUT: 'the connection timed out', ERR_NAME_NOT_RESOLVED: 'that address wasn’t found', ERR_INTERNET_DISCONNECTED: 'you’re offline', ERR_CONNECTION_REFUSED: 'the connection was refused' }[raw.match(/net::(\w+)/)?.[1]];
        throw new TypeError(why ? `Couldn’t reach ${new URL(url).hostname}: ${why}. Check your connection and try again.` : raw);
      }
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': r.contentType } });
    }
    return nativeFetch(input, init);
  };
})();
