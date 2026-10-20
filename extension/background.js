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
        initiatorDomains: [chrome.runtime.id],
      },
    }],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  installHeaderRule();
  chrome.contextMenus.create({ id: 'read-selection', title: 'Read selection aloud', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'read-page', title: 'Read this page aloud', contexts: ['page'] });
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

export async function startReading(tabId, mode = 'auto') {
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
  chrome.tabs.sendMessage(tabId, { event: 'start', mode });
}

chrome.action.onClicked.addListener((tab) => startReading(tab.id, 'auto'));
chrome.commands.onCommand.addListener((command, tab) => { if (command === 'read' && tab) startReading(tab.id, 'auto'); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab) startReading(tab.id, info.menuItemId === 'read-selection' ? 'selection' : 'page');
});
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === activeTabId) { sendToPlayer({ cmd: 'stop' }); activeTabId = null; } });

async function sendToPlayer(msg) {
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'player' && sender.tab) {
    activeTabId = sender.tab.id;
    sendToPlayer(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.target === 'tab' && activeTabId !== null) {
    chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
    return false;
  }
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
