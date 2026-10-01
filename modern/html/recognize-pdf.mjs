// Rendering/recognition adapter; the Rust parser still owns page selection and structure.
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/build/pdf.mjs';
import { assetURL } from '../browser-ocr/assets.mjs';
import { recognizePage } from '../browser-ocr/ocr.mjs';

// One page at a time: queued priority pages first, then source order.
const queue = [], sourceOrder = new Map();
// Sources whose pages have begun, until one has no next page queued.
const started = new Set();
let running = false;
function schedulePage(source, priority, run) {
  if (!sourceOrder.has(source)) sourceOrder.set(source, sourceOrder.size);
  return new Promise((resolve, reject) => {
    queue.push({ source, order: sourceOrder.get(source), priority, run, resolve, reject });
    if (!running) { running = true; setTimeout(drain, 0); }
  });
}
/** Whether a source's pages are queued behind another source's, none of its own begun. */
export const recognitionWaiting = (source) => !started.has(source) && queue.some(job => job.source === source);
async function drain() {
  // A source that queued no next page by now has finished.
  for (const source of started) if (!queue.some(job => job.source === source)) started.delete(source);
  queue.sort((a,b) => Number(b.priority)-Number(a.priority) || a.order-b.order);
  const job = queue.shift();
  if (!job) { running = false; return; }
  started.add(job.source);
  try { job.resolve(await job.run()); } catch (error) { job.reject(error); }
  // Let the source enqueue its next page before selecting the next job.
  setTimeout(drain, 0);
}
export async function recognizePdf(bytes, sourceSha256, pages, signal, completed = () => {}, priorityPages = pages, order) {
  signal?.throwIfAborted();
  if (order !== undefined) sourceOrder.set(sourceSha256, order);
  const key = `${__OCR_RUNTIME_SHA256__}:${sourceSha256}`;
  const cached = await readCache(key);
  const retained = new Map((cached?.pages ?? []).map(page => [page.page_index, page]));
  GlobalWorkerOptions.workerSrc = assetURL('pdfWorker');
  let task;
  const pdfDocument = async () => {
    task ??= getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true });
    return task.promise;
  };
  try {
    if (!pages) pages = Array.from({length:(await pdfDocument()).numPages},(_,index)=>index);
    completed(pages.filter(index=>retained.has(index)).length);
    for (const page_index of pages) {
      signal?.throwIfAborted();
      if (retained.has(page_index)) continue;
      const result = schedulePage(sourceSha256, priorityPages?.includes(page_index) ?? false, async () => {
      signal?.throwIfAborted();
      const current = await readCache(key);
      const found = current?.pages.find(page=>page.page_index===page_index);
      if (found) return found;
      const page = await (await pdfDocument()).getPage(page_index + 1);
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
        signal?.throwIfAborted();
        await writeCache(key, {source_sha256:sourceSha256,pages:[...(current?.pages ?? []),result]});
        return result;
      } finally { canvas.width = canvas.height = 1; page.cleanup(); }
      });
      retained.set(page_index,await result);
      completed(pages.filter(index=>retained.has(index)).length);
    }
    signal?.throwIfAborted();
    return { source_sha256: sourceSha256, pages: pages.map(page => retained.get(page)) };
  } finally { await task?.destroy(); }
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
