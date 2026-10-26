// Settings: where the reader's provider voices come from. Same rules as the extension's options
// page; the setting is chrome.storage.sync "server" (the shim keeps it in localStorage).
import { DEFAULT_SERVER } from './engine/server.js';

const $ = (id) => document.getElementById(id);
const input = $('server');
let clearNote;
const note = (text) => {
  $('status').textContent = text;
  clearTimeout(clearNote);
  clearNote = setTimeout(() => { $('status').textContent = ''; }, 3000);
};
$('default-url').textContent = DEFAULT_SERVER;

// Unset means the default, so the field shows the default then
chrome.storage.sync.get('server').then(({ server }) => { input.value = server === undefined ? DEFAULT_SERVER : server; });

// A refused address keeps its message until the field changes; otherwise the form would block the next Save
input.addEventListener('input', () => input.setCustomValidity(''));

$('server-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = input.value.trim().replace(/\/+$/, '');
  input.setCustomValidity(value && !/^https?:\/\/\S+$/i.test(value) ? 'Enter a web address starting with http:// or https://, or leave the field empty' : '');
  if (!input.reportValidity()) return;
  input.value = value;
  // The default is stored as "unset", so an install keeps following the default if it ever moves
  if (value === DEFAULT_SERVER) await chrome.storage.sync.remove('server');
  else await chrome.storage.sync.set({ server: value });
  localStorage.removeItem('dan.serverVoiceCache'); // list the new server's voices right away
  let text = value ? 'Saved' : 'Saved: Edge voices only';
  if (!value) {
    // With no server, a stored provider voice could never play: go back to the default Edge voice
    const { voice } = await chrome.storage.sync.get('voice');
    if (/^[a-z][a-z0-9]*:/i.test(voice || '')) { await chrome.storage.sync.set({ voice: 'en-US-AriaNeural' }); text += ' (voice reset to Aria)'; }
  }
  note(text);
});
