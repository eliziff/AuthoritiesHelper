// The engine's PDF parse cache, kept by the page (IndexedDB) by source hash, so a reload or a
// later visit reads a PDF already parsed instead of parsing it again. The cache files are named
// by the engine's own cache key, which changes with the engine: a stale entry is never read and
// leaves, least recently used, once the store is full. Losing it only costs a parse.
const LIMIT = 256 * 1024 * 1024;
let database;
const open = () => database ??= new Promise((resolve) => {
  try {
    const request = indexedDB.open("authorities-parse-cache", 1);
    request.onupgradeneeded = () => {
      // The files, and apart from them each source's size and last use, read to make room.
      request.result.createObjectStore("files");
      request.result.createObjectStore("uses");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  } catch { resolve(null); }
});

function transact(work) {
  return open().then((db) => db && new Promise((resolve) => {
    let result = null;
    const transaction = db.transaction(["files", "uses"], "readwrite");
    work(transaction.objectStore("files"), transaction.objectStore("uses"), (value) => { result = value; });
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = transaction.onabort = () => resolve(null);
  })).catch(() => null);
}

/** The cache files kept for this source, or null. */
export const readParseCache = (sha256) => transact((files, uses, done) => {
  const request = files.get(sha256);
  request.onsuccess = () => {
    if (!request.result) return;
    done(request.result);
    const use = uses.get(sha256);
    use.onsuccess = () => use.result && uses.put({ ...use.result, used: Date.now() }, sha256);
  };
});

/** Keeps this source's cache files, in place of those kept before. */
export const writeParseCache = (sha256, kept) => transact((files, uses) => {
  files.put(kept, sha256);
  uses.put({ size: kept.reduce((total, [, content]) => total + content.byteLength, 0), used: Date.now() }, sha256);
  const all = uses.getAll(), keys = uses.getAllKeys();
  keys.onsuccess = () => {
    const rows = keys.result.map((key, index) => ({ key, ...all.result[index] })).sort((a, b) => a.used - b.used);
    let total = rows.reduce((sum, row) => sum + row.size, 0);
    for (const row of rows) {
      if (total <= LIMIT) break;
      if (row.key === sha256) continue;
      files.delete(row.key); uses.delete(row.key); total -= row.size;
    }
  };
});
