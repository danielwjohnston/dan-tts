// Entry points (toolbar, context menu, shortcut), header rule, and message relay
// between the page's content script and the offscreen player.
import { EDGE_ORIGIN, EDGE_USER_AGENT, listVoices } from './engine/tts.js';

const RULE_ID = 1;

// Microsoft's service only answers requests that look like Edge's Read Aloud. Rewrite
// Origin/User-Agent, but only for requests made by this extension: websites can't use it.
async function installHeaderRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: EDGE_ORIGIN },
          { header: 'User-Agent', operation: 'set', value: EDGE_USER_AGENT },
        ],
      },
      condition: {
        urlFilter: '||speech.platform.bing.com',
        resourceTypes: ['websocket', 'xmlhttprequest'],
        // The extension's own origin host: its id in Chrome, a per-install UUID in Firefox
        initiatorDomains: [new URL(chrome.runtime.getURL('')).host],
      },
    }],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  installHeaderRule();
  // removeAll first: on updates the old items may still exist, and duplicate ids throw
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-selection', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'read-page', title: 'Read this page aloud', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'open-library', title: 'Open library', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'open-pdf', title: 'Read a PDF file…', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'send-to-web', title: "Send to Dan's TTS web app", contexts: ['selection', 'page'] });
  });
});
chrome.runtime.onStartup.addListener(installHeaderRule);

// ---- Offscreen player ----
let creatingOffscreen = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play synthesized speech for the page being read',
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

// ---- Start reading in a tab ----
let activeTabId = null;
let activeIsExtensionPage = false; // the PDF reader page hears the player directly

const READER_URL = chrome.runtime.getURL('pdf-reader.html');
// Same hand-off as the web app's bookmarklet: text travels in the #fragment, which never reaches the server
const WEB_APP_URL = 'https://dan-tts.macdaddydwj.workers.dev/tester';
const MAX_SEND_CHARS = 100000;

async function sendToWebApp(tab, selectionText) {
  // Read from the page so line breaks survive (the menu's selectionText collapses them)
  let text = '';
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => getSelection().toString() || document.body.innerText,
    });
    text = res?.result || '';
  } catch (err) {
    console.warn('Could not read page text:', err);
  }
  text ||= selectionText || '';
  chrome.tabs.create({ url: `${WEB_APP_URL}#text=${encodeURIComponent(text.slice(0, MAX_SEND_CHARS))}`, index: tab.index + 1 });
}
const isPdfUrl = (url) => /^(https?|file):/.test(url || '') && /\.pdf($|[?#])/i.test(url);

export async function startReading(tabId, mode = 'auto') {
  // The browser's PDF viewer can't be scripted: open the PDF in dan-tts' own reader instead
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isPdfUrl(tab.url)) {
    chrome.tabs.create({ url: `${READER_URL}?url=${encodeURIComponent(tab.url)}`, index: tab.index + 1 });
    return;
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/Readability.js', 'lib/chunk-text.js', 'lib/align.js', 'content.js'] });
  } catch (err) {
    // chrome://, the Web Store and some other pages can't be scripted
    console.warn('dan-tts: cannot read this page', err);
    chrome.action.setBadgeText({ tabId, text: '✕' });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 2500);
    return;
  }
  if (activeTabId !== null && activeTabId !== tabId) sendToPlayer({ cmd: 'stop' });
  activeTabId = tabId;
  activeIsExtensionPage = false;
  chrome.tabs.sendMessage(tabId, { event: 'start', mode });
}

chrome.action.onClicked.addListener((tab) => startReading(tab.id, 'auto'));
chrome.commands.onCommand.addListener((command, tab) => { if (command === 'read' && tab) startReading(tab.id, 'auto'); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-library') { chrome.tabs.create({ url: chrome.runtime.getURL('library.html') }); return; }
  if (info.menuItemId === 'open-pdf') { chrome.tabs.create({ url: READER_URL }); return; }
  if (info.menuItemId === 'send-to-web') { if (tab) sendToWebApp(tab, info.selectionText).catch(console.error); return; }
  if (tab) startReading(tab.id, info.menuItemId === 'read-selection' ? 'selection' : 'page');
});
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === activeTabId) { sendToPlayer({ cmd: 'stop' }); activeTabId = null; } });

// Firefox has no offscreen documents: run the player inside this background page instead
let inlinePlayer = null;
async function sendToPlayer(msg) {
  if (!chrome.offscreen) {
    inlinePlayer ??= import('./offscreen.js').then((m) => { m.setEventSink(relayToTab); return m; });
    (await inlinePlayer).handleCommand(msg);
    return { ok: true };
  }
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
}

// ---- Voices (cached for a day) ----
async function getVoices() {
  const { voiceCache } = await chrome.storage.local.get('voiceCache');
  if (voiceCache && Date.now() - voiceCache.at < 86400000) return voiceCache.voices;
  const voices = (await listVoices()).map(({ ShortName, Locale, LocaleName, Gender, FriendlyName }) => ({ ShortName, Locale, LocaleName, Gender, FriendlyName }));
  await chrome.storage.local.set({ voiceCache: { at: Date.now(), voices } });
  return voices;
}

// ---- Relay ----
// Player events → the tab being read. Extension pages (the PDF reader) hear an offscreen
// player's broadcasts directly; with the inline (Firefox) player they need forwarding.
function relayToTab(msg) {
  if (activeTabId === null) return;
  if (activeIsExtensionPage) {
    if (!chrome.offscreen) chrome.runtime.sendMessage(msg).catch(() => {});
    return;
  }
  chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'player' && sender.tab) {
    activeTabId = sender.tab.id;
    activeIsExtensionPage = (sender.url || '').startsWith(chrome.runtime.getURL(''));
    sendToPlayer(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.target === 'tab') { relayToTab(msg); return false; }
  // Pages ping this while reading: Firefox suspends idle background pages (~30 s), which
  // would stop audio played here. Harmless in Chrome.
  if (msg.target === 'background' && msg.cmd === 'keepalive') { sendResponse({ ok: true }); return false; }
  if (msg.target === 'background' && msg.cmd === 'voices') {
    getVoices().then((voices) => sendResponse({ voices }), (e) => sendResponse({ error: e.message }));
    return true;
  }
  return false;
});

// Ensure the rule exists whenever the worker wakes (dynamic rules persist, but cheap to check)
chrome.declarativeNetRequest.getDynamicRules().then((rules) => { if (!rules.some((r) => r.id === RULE_ID)) installHeaderRule(); });

// Exposed for the end-to-end test harness (and handy from the service worker console)
globalThis.startReading = startReading;
