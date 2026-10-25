// dan-tts Reader (desktop). The window shows the same reader UI as the browser extension
// (copied into app/ by scripts/sync-desktop.mjs). This process does the two things a web
// page can't: add the request headers Microsoft's voice service expects, and download
// pages/PDFs from any site.
const { app, BrowserWindow, ipcMain, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_DOWNLOAD = 100 * 1024 * 1024;
const APP_DIR = path.join(__dirname, 'app');

// The UI is served from app://reader/ (not file://) so workers, fetch and modules behave
// like on the web. Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Tests run with a throwaway profile
if (process.env.DAN_TTS_USER_DATA) app.setPath('userData', process.env.DAN_TTS_USER_DATA);

// Optional proxy (e.g. corporate networks): DAN_TTS_PROXY=http://host:port
if (process.env.DAN_TTS_PROXY) {
  app.commandLine.appendSwitch('proxy-server', process.env.DAN_TTS_PROXY);
  app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 520,
    minHeight: 480,
    title: 'dan-tts Reader',
    backgroundColor: '#fbfaf7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL('app://reader/home.html');
  // Links to the web open in the user's browser; only our own pages load in the window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://reader/')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  return win;
}

app.whenReady().then(async () => {
  // Header values come from the shared engine, so there's one place to update them
  const { EDGE_ORIGIN, EDGE_USER_AGENT } = await import(pathToFileURL(path.join(APP_DIR, 'engine', 'tts.js')).toString());

  protocol.handle('app', (request) => {
    const { host, pathname } = new URL(request.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (host !== 'reader' || !file.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // The voice service only answers requests that look like Edge's Read Aloud. Rewrite the
  // headers for that host only (the desktop equivalent of the extension's header rule).
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://speech.platform.bing.com/*', 'wss://speech.platform.bing.com/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders, Origin: EDGE_ORIGIN, 'User-Agent': EDGE_USER_AGENT };
      callback({ requestHeaders: headers });
    },
  );
  // No camera, microphone, notifications or the like are ever needed
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  // Download a web page or PDF on the renderer's behalf (pages can't fetch other sites).
  ipcMain.handle('dan:fetch', async (_event, url) => {
    let u;
    try { u = new URL(url); } catch { throw new Error('Not a valid web address'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http:// and https:// addresses can be opened');
    const res = await net.fetch(u.toString(), { headers: { 'User-Agent': `Mozilla/5.0 (compatible; dan-tts-desktop/${app.getVersion()})` } });
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_DOWNLOAD) throw new Error('That file is too large (over 100 MB)');
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > MAX_DOWNLOAD) throw new Error('That file is too large (over 100 MB)');
    return { ok: res.ok, status: res.status, url: res.url, contentType: res.headers.get('content-type') || '', body };
  });

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
