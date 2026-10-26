// Settings page: where the reader's provider voices come from. Edge voices need no server.
import { DEFAULT_SERVER } from './engine/server.js';

const input = document.getElementById('server');
const saved = document.getElementById('saved');
document.getElementById('default-url').textContent = DEFAULT_SERVER;

chrome.storage.sync.get('server').then(({ server }) => { input.value = server === undefined ? DEFAULT_SERVER : server; });

document.getElementById('save').addEventListener('click', async () => {
  const value = input.value.trim().replace(/\/+$/, '');
  input.setCustomValidity(value && !/^https?:\/\/\S+$/i.test(value) ? 'Enter a web address starting with http:// or https://, or leave the field empty' : '');
  if (!input.reportValidity()) return;
  // The default is stored as "unset", so an install keeps following the default if it ever moves
  if (value === DEFAULT_SERVER) await chrome.storage.sync.remove('server');
  else await chrome.storage.sync.set({ server: value });
  await chrome.storage.local.remove('serverVoiceCache'); // list the new server's voices right away
  let note = value ? 'Saved' : 'Saved: Edge voices only';
  if (!value) {
    // With no server, a stored provider voice could never play: go back to the default Edge voice
    const { voice } = await chrome.storage.sync.get('voice');
    if (/^[a-z][a-z0-9]*:/i.test(voice || '')) { await chrome.storage.sync.set({ voice: 'en-US-AriaNeural' }); note += ' (voice reset to Aria)'; }
  }
  saved.textContent = note;
  setTimeout(() => { saved.textContent = ''; }, 3000);
});
