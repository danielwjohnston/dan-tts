// Settings page: where the reader's provider voices come from. Edge voices need no server.
const DEFAULT_SERVER = 'https://dan-tts.macdaddydwj.workers.dev';
const input = document.getElementById('server');
const saved = document.getElementById('saved');

chrome.storage.sync.get('server').then(({ server }) => { input.value = server === undefined ? DEFAULT_SERVER : server; });

document.getElementById('save').addEventListener('click', async () => {
  const value = input.value.trim().replace(/\/+$/, '');
  input.setCustomValidity(value && !/^https?:\/\/\S+$/i.test(value) ? 'Enter a web address starting with http:// or https://, or leave the field empty' : '');
  if (!input.reportValidity()) return;
  await chrome.storage.sync.set({ server: value });
  await chrome.storage.local.remove('serverVoiceCache'); // list the new server's voices right away
  saved.textContent = value ? 'Saved' : 'Saved: Edge voices only';
  setTimeout(() => { saved.textContent = ''; }, 2500);
});
