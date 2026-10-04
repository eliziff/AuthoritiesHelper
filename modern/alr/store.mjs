// What the page keeps in this browser (IndexedDB) so a reload loses nothing: the settings, the
// documents added and each one's finished result, the watched folder, and the answers sources gave
// to lookups (served to the runtime through the page bridge's AUTHORITIES_SOURCE_ANSWERS).

const DATABASE = "alr-quote-verifier", KEPT = "kept", ANSWERS = "sourceAnswers";
let opened;
function database() {
  return opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(KEPT);
      request.result.createObjectStore(ANSWERS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function call(store, mode, action) {
  const transaction = (await database()).transaction(store, mode);
  const request = action(transaction.objectStore(store));
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

/** A kept value (settings, documents, results, folder handle), or undefined. Never throws: a page
 *  without storage (a private window) still works, without keeping anything. */
export const kept = (key) => call(KEPT, "readonly", (store) => store.get(key)).catch(() => undefined);
export const keep = (key, value) => call(KEPT, "readwrite", (store) =>
  value === undefined ? store.delete(key) : store.put(value, key)).catch(() => {});

globalThis.AUTHORITIES_SOURCE_ANSWERS = {
  async read(url) {
    const answer = await call(ANSWERS, "readonly", (store) => store.get(url)).catch(() => undefined);
    return answer && answer.expires > Date.now() ? answer.body : null;
  },
  remember: (url, body, expires) => call(ANSWERS, "readwrite", (store) => store.put({ body, expires }, url)).catch(() => {}),
};
