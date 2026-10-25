// EPUB files opened from the computer. A book page reloads the book on every chapter, and a
// local file can't be fetched again by address, so its bytes are kept in IndexedDB under
// their SHA-256 (the same file opened twice is stored once).
const DB = 'dan-tts-books';
const STORE = 'files';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Saves a file's bytes; returns the key to open it with (book.html?file=key) */
export async function saveBookFile(name, data) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const key = [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await run('readwrite', (s) => s.put({ name, data, savedAt: Date.now() }, key));
  return key;
}

/** { name, data } or undefined */
export const getBookFile = (key) => run('readonly', (s) => s.get(key));
