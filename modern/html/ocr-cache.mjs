// Disposable inference, keyed by the source bytes and packaged model. Each page is stored once;
// quota/failure only loses recognition reuse, never a draft.
const MAX_BYTES = 64 * 1024 * 1024;
const memory = new Map();
let memoryBytes = 0, database;
const pageKey = (key, page) => `${key}:${page}`;
function remember(key, page, size = JSON.stringify(page).length * 2) {
  const id = pageKey(key, page.page_index), previous = memory.get(id);
  if (previous) { memoryBytes -= previous.size; memory.delete(id); }
  if (size > MAX_BYTES) return;
  memory.set(id, { key, page, size }); memoryBytes += size;
  for (const [old, entry] of memory) {
    if (memoryBytes <= MAX_BYTES) break;
    memory.delete(old); memoryBytes -= entry.size;
  }
}
function cacheDatabase() {
  return database ??= new Promise(resolve => {
    const request = indexedDB.open('authorities-browser-ocr', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      // The old whole-document inference cache is disposable.
      if (db.objectStoreNames.contains('pages')) db.deleteObjectStore('pages');
      db.createObjectStore('pages', { keyPath: 'key' });
      db.createObjectStore('entries', { keyPath: 'key' }).createIndex('used', 'used');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => resolve(null);
    request.onblocked = () => { request.onsuccess = () => request.result.close(); resolve(null); };
  });
}

/** Zero-based requested pages, or the complete source for the parser's recognition pass. */
export async function readCachedPages(key, pages) {
  const found = new Map();
  const retained = [...memory.values()].filter(entry => entry.key === key && (!pages || pages.includes(entry.page.page_index)));
  for (const entry of retained) { found.set(entry.page.page_index, entry.page); remember(key, entry.page, entry.size); }
  if (!pages || pages.some(page => !found.has(page))) try {
    const db = await cacheDatabase();
    if (db) {
      const store = db.transaction('pages').objectStore('pages');
      const read = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const rows = pages ? await Promise.all(pages.filter(page => !found.has(page)).map(page => read(store.get([key, page]))))
        : await read(store.getAll(IDBKeyRange.bound([key, 0], [key, Infinity])));
      for (const row of rows) if (row && !found.has(row.page.page_index)) {
        found.set(row.page.page_index, row.page); remember(key, row.page);
      }
    }
  } catch { /* The in-memory pages remain usable without browser storage. */ }
  return [...found.values()].sort((a, b) => a.page_index - b.page_index);
}

export async function writeCachedPage(key, page) {
  const size = JSON.stringify(page).length * 2;
  remember(key, page, size);
  if (size > MAX_BYTES) return;
  try {
    const db = await cacheDatabase();
    if (!db) return;
    await new Promise(resolve => {
      const transaction = db.transaction(['pages', 'entries'], 'readwrite');
      const store = transaction.objectStore('pages'), entries = transaction.objectStore('entries'), id = [key, page.page_index];
      // The byte total and page replacement commit together, including writes from other tabs.
      const previous = entries.get(id), total = entries.get('bytes');
      let pending = 2;
      previous.onsuccess = total.onsuccess = () => {
        if (--pending) return;
        let bytes = (total.result?.bytes ?? 0) - (previous.result?.size ?? 0) + size;
        store.put({ key: id, page }); entries.put({ key: id, size, used: Date.now() });
        entries.put({ key: 'bytes', bytes });
        if (bytes <= MAX_BYTES) return;
        // Eviction reads only small size/age records, never every PDF's recognized text.
        const oldest = entries.index('used').openCursor();
        oldest.onsuccess = () => {
          const cursor = oldest.result;
          if (!cursor || bytes <= MAX_BYTES) { entries.put({ key: 'bytes', bytes }); return; }
          bytes -= cursor.value.size; store.delete(cursor.primaryKey); cursor.delete(); cursor.continue();
        };
      };
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
    });
  } catch { /* Recognition remains usable without persistent browser storage. */ }
}
