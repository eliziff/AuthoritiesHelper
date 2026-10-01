// Rendering/recognition adapter; the Rust parser still owns page selection and structure.
import { getDocument, PDFWorker } from 'pdfjs-dist/build/pdf.mjs';
import { assetURL } from '../browser-ocr/assets.mjs';
import { OCR_PARALLEL, recognizePage } from '../browser-ocr/ocr.mjs';

// PDF.js decodes pages in its own worker. Started from a file:// page, PDF.js cannot load the worker
// itself (it wraps the script in a blob:null module that may not import another) and silently runs
// it on the main thread, where decoding a scanned page blocks the page for hundreds of ms.
let pdfWorker;
const worker = () => pdfWorker ??= new PDFWorker({ port: new Worker(assetURL('pdfWorker'), { type: 'module' }) });

// A source's PDF.js document, opened once for every pass and page reading it, and closed
// when none is left.
const documents = new Map();
function useDocument(source, bytes) {
  let entry = documents.get(source);
  if (!entry) documents.set(source, entry = { users: 0, task: null,
    // A copy: PDF.js takes the bytes it is given to its worker.
    open: () => (entry.task ??= getDocument({ data: bytes.slice(), isEvalSupported: false,
      useSystemFonts: true, worker: worker() })).promise });
  entry.users += 1;
  return { open: entry.open, close() {
    if (--entry.users) return;
    documents.delete(source); void entry.task?.destroy();
  } };
}

// As many pages at once as there are recognizers: queued priority pages first, then source order.
// A page is read once however many passes ask for it, at the highest priority any asks.
const queue = [], sourceOrder = new Map(), reads = new Map();
// Sources whose pages have begun, until one has no page queued or being read.
const started = new Set();
let running = 0, held = 0;
/** While the promise is pending, pages no one waits on (none of priority) are not begun. */
export function holdBackground(promise) {
  held += 1;
  promise.finally(() => { held -= 1; setTimeout(drain, 0); });
}
function readPage(source, key, bytes, page_index, priority, signal) {
  const id = `${key}:${page_index}`;
  let job = reads.get(id);
  if (!job) {
    const controller = new AbortController();
    job = { source, order: sourceOrder.get(source), priority, controller, askers: 0,
      run: () => recognizeOne(source, key, bytes, page_index, controller.signal) };
    job.result = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    job.result.catch(() => {}).finally(() => { if (reads.get(id) === job) reads.delete(id); });
    reads.set(id, job); queue.push(job);
  }
  job.priority ||= priority;
  job.askers += 1;
  setTimeout(drain, 0);
  return new Promise((resolve, reject) => {
    const leave = () => {
      reject(signal.reason ?? new DOMException('Recognition cancelled', 'AbortError'));
      if (--job.askers) return;
      // No pass wants the page any more: a queued read is dropped, a running one stopped.
      if (reads.get(id) === job) reads.delete(id);
      const queued = queue.indexOf(job);
      if (queued >= 0) queue.splice(queued, 1);
      job.controller.abort();
    };
    signal?.addEventListener('abort', leave, { once: true });
    job.result.then(resolve, reject).finally(() => signal?.removeEventListener('abort', leave));
  });
}
/** Whether a source's pages are queued behind another source's, none of its own begun. */
export const recognitionWaiting = (source) => !started.has(source) && queue.some(job => job.source === source);
const reading = new Map();
function drain() {
  // A source with no page queued or being read by now has finished.
  for (const source of started) if (!reading.get(source) && !queue.some(job => job.source === source)) started.delete(source);
  queue.sort((a,b) => Number(b.priority)-Number(a.priority) || a.order-b.order);
  while (running < OCR_PARALLEL && queue.length && (queue[0].priority || !held)) {
    const job = queue.shift();
    running += 1; started.add(job.source); reading.set(job.source, (reading.get(job.source) ?? 0) + 1);
    job.run().then(job.resolve, job.reject).finally(() => {
      running -= 1; reading.set(job.source, reading.get(job.source) - 1);
      // Let the source enqueue its next page before selecting the next job.
      setTimeout(drain, 0);
    });
  }
}
async function recognizeOne(source, key, bytes, page_index, signal) {
  signal.throwIfAborted();
  const found = (await readCache(key))?.pages.find(page=>page.page_index===page_index);
  if (found) return found;
  const pdf = useDocument(source, bytes);
  try {
    const page = await (await pdf.open()).getPage(page_index + 1);
    const raw = page.view, rotated = page.rotate % 180 !== 0;
    const width = raw[rotated ? 3 : 2] - raw[rotated ? 1 : 0];
    const height = raw[rotated ? 2 : 3] - raw[rotated ? 0 : 1];
    let viewport = page.getViewport({ scale: 200 / 72 });
    if (viewport.width * viewport.height > 12_000_000)
      viewport = page.getViewport({ scale: viewport.scale * Math.sqrt(12_000_000 / (viewport.width * viewport.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    try {
      await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport }).promise;
      const recognized = await recognizePage(canvas, signal);
      const x = value => Math.max(0, Math.min(width, value * width / viewport.width));
      const y = value => Math.max(0, Math.min(height, value * height / viewport.height));
      const result = { page_index, width, height, lines: recognized.map(line => ({
        text: line.text, confidence: 0.5,
        bbox: [x(line.x), y(line.y), x(line.x + line.width), y(line.y + line.height)],
      })) };
      signal.throwIfAborted();
      await addCachedPage(key, source, result);
      return result;
    } finally { canvas.width = canvas.height = 1; page.cleanup(); }
  } finally { pdf.close(); }
}
export async function recognizePdf(bytes, sourceSha256, pages, signal, completed = () => {}, priorityPages = pages, order) {
  signal?.throwIfAborted();
  if (order !== undefined) sourceOrder.set(sourceSha256, order);
  else if (!sourceOrder.has(sourceSha256)) sourceOrder.set(sourceSha256, sourceOrder.size);
  const key = `${__OCR_RUNTIME_SHA256__}:${sourceSha256}`;
  const cached = await readCache(key);
  const retained = new Map((cached?.pages ?? []).map(page => [page.page_index, page]));
  // Held for the whole pass, so its pages share one open document.
  const pdf = useDocument(sourceSha256, bytes);
  try {
    if (!pages) pages = Array.from({length:(await pdf.open()).numPages},(_,index)=>index);
    completed(pages.filter(index=>retained.has(index)).length);
    await Promise.all(pages.filter(page_index => !retained.has(page_index)).map(async page_index => {
      signal?.throwIfAborted();
      retained.set(page_index, await readPage(sourceSha256, key, bytes, page_index,
        priorityPages?.includes(page_index) ?? false, signal));
      completed(pages.filter(index=>retained.has(index)).length);
    }));
    signal?.throwIfAborted();
    return { source_sha256: sourceSha256, pages: pages.map(page => retained.get(page)) };
  } finally { pdf.close(); }
}

const textPages = new WeakMap();
export async function readRecognizedText(sourceSha256, pages) {
  const cached = await readCache(`${__OCR_RUNTIME_SHA256__}:${sourceSha256}`);
  return {pages:(cached?.pages ?? []).filter(page=>!pages || pages.includes(page.page_index+1)).map(page=>{
    // Stable page objects keep OCR progress from rebuilding existing selection layers.
    if (!textPages.has(page)) textPages.set(page, {
      pageNumber:page.page_index+1,width:page.width,height:page.height,
      lines:page.lines.map((line,index)=>({id:String(index),text:line.text,rect:line.bbox,words:[]})),
    });
    return textPages.get(page);
  })};
}

// A disposable inference cache, keyed by both source bytes and the packaged model.
// Failure/quota eviction only causes recognition again; it never loses a draft.
let database;
const memory = new Map();
function remember(key, value) {
  memory.delete(key);
  memory.set(key,{value,size:JSON.stringify(value).length*2});
  let size=[...memory.values()].reduce((total,item)=>total+item.size,0);
  for(const [old,item] of memory){if(size<=64*1024*1024)break;memory.delete(old);size-=item.size;}
}
function cacheDatabase() {
  return database ??= new Promise(resolve => {
    const request = indexedDB.open('authorities-browser-ocr', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pages', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}
async function readCache(key) {
  if(memory.has(key))return memory.get(key).value;
  try {
    const db = await cacheDatabase();
    if (!db) return null;
    const value = await new Promise(resolve => {
      const request = db.transaction('pages').objectStore('pages').get(key);
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => resolve(null);
    });
    if(value)remember(key,value);
    return value;
  } catch { return null; }
}
// Pages of one source finish side by side; each is added to the latest record, never a stale one.
const adding = new Map();
function addCachedPage(key, sourceSha256, result) {
  const next = (adding.get(key) ?? Promise.resolve()).then(async () => {
    const pages = ((await readCache(key))?.pages ?? []).filter(page => page.page_index !== result.page_index);
    await writeCache(key, { source_sha256: sourceSha256, pages: [...pages, result] });
  });
  adding.set(key, next.catch(() => {}));
  return next;
}
async function writeCache(key, value) {
  remember(key,value);
  try {
    const db = await cacheDatabase();
    if (!db) return;
    await new Promise(resolve => {
      const transaction = db.transaction('pages', 'readwrite'), store = transaction.objectStore('pages');
      store.put({ key, value, used: Date.now(), size: JSON.stringify(value).length * 2 });
      const records = store.getAll();
      records.onsuccess = () => {
        const rows = records.result.sort((a, b) => a.used - b.used);
        let size = rows.reduce((total, row) => total + row.size, 0);
        for (const row of rows) {
          if (size <= 64 * 1024 * 1024) break;
          store.delete(row.key); size -= row.size;
        }
      };
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
    });
  } catch { /* Recognition remains usable without persistent browser storage. */ }
}
