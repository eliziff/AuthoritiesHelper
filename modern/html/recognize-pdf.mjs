// Rendering/recognition adapter; the Rust parser still owns page selection and structure.
import { assetsReady, assetURL } from '../browser-ocr/assets.mjs';
import { ocrParallelism, prepareOCR, recognizePage } from '../browser-ocr/ocr.mjs';
import { readCachedPages, writeCachedPage } from './ocr-cache.mjs';

// PDF.js opens and draws the pages in one worker (raster-worker.mjs), so this thread never draws or
// reads a page's pixels (50-100 ms a page): it only routes them to the recognizer's workers. Left with
// no document open for a while, it ends, and the memory PDF.js holds with it.
let raster, rasterEnding, asked = 0;
const RASTER_IDLE_MS = 30_000;
function rasterQuiet() {
  clearTimeout(rasterEnding);
  if (raster && !documents.size && !answers.size) rasterEnding = setTimeout(() => {
    if (documents.size || answers.size) return;
    raster.terminate(); raster = undefined;
  }, RASTER_IDLE_MS);
}
const answers = new Map();
function rasterWorker() {
  const worker = new Worker(assetURL('rasterWorker'));
  worker.onmessage = ({ data }) => {
    const answer = answers.get(data.id); if (!answer) return;
    answers.delete(data.id); data.error === undefined ? answer.resolve(data) : answer.reject(new Error(data.error));
    rasterQuiet();
  };
  worker.onerror = (event) => {
    for (const answer of answers.values()) answer.reject(new Error(event.message || 'The PDF renderer failed.'));
    answers.clear();
  };
  // The viewer's PDF.js worker and image decoders, shared rather than carried twice. PDF.js decodes JPEG
  // with the browser except in Chrome, which it tells by `globalThis.chrome`.
  const imageDecoder = navigator.userAgent.includes('Firefox') || !globalThis.chrome;
  Promise.all([globalThis.AUTHORITIES_PDF_WORKER_URL(), globalThis.AUTHORITIES_PDF_DECODERS()]).then(
    ([pdfWorker, decoders]) => worker.postMessage({ pdfWorker, decoders, imageDecoder }),
    (error) => worker.postMessage({ failed: error.message || 'PDF.js could not start.' }));
  return worker;
}
function ask(message, transfer) {
  clearTimeout(rasterEnding);
  raster ??= rasterWorker();
  return new Promise((resolve, reject) => {
    answers.set(++asked, { resolve, reject });
    raster.postMessage({ ...message, id: asked }, transfer);
  });
}

// A source's PDF.js document, opened once for every pass and page reading it, and closed
// when none is left. Opening it gives its page count.
const documents = new Map();
function useDocument(source, bytes) {
  let entry = documents.get(source);
  if (!entry) documents.set(source, entry = { users: 0, pages: null,
    // A copy: the worker takes the bytes it is given.
    open: () => entry.pages ??= assetsReady(['rasterWorker']).then(() => { const copy = bytes.slice();
      return ask({ open: source, bytes: copy }, [copy.buffer]); }).then(({ pages }) => pages) });
  entry.users += 1;
  return { open: entry.open, close() {
    if (--entry.users) return;
    documents.delete(source); if (entry.pages) raster?.postMessage({ close: source });
    rasterQuiet();
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
  while (running < ocrParallelism() && queue.length && (queue[0].priority || !held)) {
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
  const [found] = await readCachedPages(key, [page_index]);
  if (found) return found;
  const pdf = useDocument(source, bytes);
  let drawn;
  try {
    await pdf.open();
    // The owner's OCR resolution (at most 12 MP), drawn in the raster worker.
    drawn = await ask({ source, page: page_index });
    const { width, height, viewportWidth, viewportHeight } = drawn;
    const recognized = await recognizePage(drawn, signal);
    const x = value => Math.max(0, Math.min(width, value * width / viewportWidth));
    const y = value => Math.max(0, Math.min(height, value * height / viewportHeight));
    const result = { page_index, width, height, lines: recognized.map(line => ({
      text: line.text, confidence: 0.5,
      bbox: [x(line.x), y(line.y), x(line.x + line.width), y(line.y + line.height)],
    })) };
    signal.throwIfAborted();
    await writeCachedPage(key, result);
    return result;
  } finally { drawn?.bitmap.close(); pdf.close(); }
}
export async function recognizePdf(bytes, sourceSha256, pages, signal, completed = () => {}, priorityPages = pages, order) {
  signal?.throwIfAborted();
  if (order !== undefined) sourceOrder.set(sourceSha256, order);
  else if (!sourceOrder.has(sourceSha256)) sourceOrder.set(sourceSha256, sourceOrder.size);
  const key = `${__OCR_RUNTIME_SHA256__}:${sourceSha256}`;
  const cached = await readCachedPages(key, pages);
  const retained = new Map(cached.map(page => [page.page_index, page]));
  // Held for the whole pass, so its pages share one open document.
  const pdf = useDocument(sourceSha256, bytes);
  try {
    if (!pages) pages = Array.from({length:await pdf.open()},(_,index)=>index);
    completed(pages.filter(index=>retained.has(index)).length);
    const missing = pages.filter(page_index => !retained.has(page_index));
    if (missing.length) await prepareOCR(signal);
    await Promise.all(missing.map(async page_index => {
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
  const cached = await readCachedPages(`${__OCR_RUNTIME_SHA256__}:${sourceSha256}`, pages?.map(page => page - 1));
  return {pages:cached.map(page=>{
    // Stable page objects keep OCR progress from rebuilding existing selection layers.
    if (!textPages.has(page)) textPages.set(page, {
      pageNumber:page.page_index+1,width:page.width,height:page.height,
      lines:page.lines.map((line,index)=>({id:String(index),text:line.text,rect:line.bbox,words:[]})),
    });
    return textPages.get(page);
  })};
}
