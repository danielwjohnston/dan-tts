// IndexedDB helpers for the desktop app:
//  - handoff: a file picked on the home page, picked up by the next page (one use)
//  - docs: text documents (pasted text, local .txt/.md/.html) so library items can reopen them
const open = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('dan-tts-desktop', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('handoff'); req.result.createObjectStore('docs'); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const id = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export async function handOff(file) {
  const key = id();
  await tx('handoff', 'readwrite', (s) => s.put({ name: file.name, type: file.type, data: file }, key));
  return key;
}

export async function takeHandoff(key) {
  const item = await tx('handoff', 'readonly', (s) => s.get(key));
  await tx('handoff', 'readwrite', (s) => s.delete(key));
  return item;
}

/** Save a text document; same content → same id, so re-adding doesn't duplicate. */
export async function saveDoc(doc) {
  const bytes = new TextEncoder().encode(`${doc.title}\n${doc.text}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const key = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  await tx('docs', 'readwrite', (s) => s.put({ ...doc, savedAt: Date.now() }, key));
  return key;
}
export const getDoc = (key) => tx('docs', 'readonly', (s) => s.get(key));
export const deleteDoc = (key) => tx('docs', 'readwrite', (s) => s.delete(key));
