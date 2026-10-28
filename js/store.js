// Keeps the parsed plays on this device (IndexedDB) so returning visitors skip the upload.
// Storage can be unavailable (private windows, blocked site data), so every call fails soft.

const DB = "unwrapped";
const STORE = "data";
const KEY = "plays";

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
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function savePlays(plays) {
  try {
    await run("readwrite", (s) => s.put(plays, KEY));
  } catch (err) {
    console.warn("Couldn't remember data on this device", err);
  }
}

export async function loadPlays() {
  try {
    const plays = await run("readonly", (s) => s.get(KEY));
    return Array.isArray(plays) && plays.length ? plays : null;
  } catch (err) {
    console.warn("Couldn't read remembered data", err);
    return null;
  }
}

export async function clearPlays() {
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch (err) {
    console.warn("Couldn't forget data", err);
  }
}
