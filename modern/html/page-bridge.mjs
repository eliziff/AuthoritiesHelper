import { holdBackground, recognizePdf, readRecognizedText, recognitionWaiting } from './recognize-pdf.mjs';
import { readParseCache, writeParseCache } from './parse-cache-store.mjs';
// Runs before the Authorities workspace in the self-contained HTML. It starts the
// runtime Worker, supplies the direct Authorities operation client and serves
// PDF.js standard fonts. External requests still go to the network.
/* global __AUTHORITIES_PAYLOAD__ */

const FONTS = "/pdfjs-standard-fonts/";
const payload = __AUTHORITIES_PAYLOAD__;
globalThis.AUTHORITIES_ASSETS = payload.ocr;
globalThis.AUTHORITIES_PDF_TEXT = {
  read: readRecognizedText,
  waiting: recognitionWaiting,
  async prepare(product, role, file, priority, scanned, signal, completed) {
    const hash = product.state.bindings[role].lastSeen.sha256;
    const pages = scanned ? [...new Set([...(priority ?? []).filter(page=>scanned.includes(page)),...scanned])]
      .map(page=>page-1) : undefined;
    await recognizePdf(new Uint8Array(await file.arrayBuffer()),hash,pages,signal,completed,(priority ?? []).map(page=>page-1),
      product.state.authorityOrder.findIndex(id=>product.state.authorities[id].source.sources?.some(source=>source.bindingRole===role)));
  },
};
const decode = (base64) => {
  const text = atob(base64), bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
};
const inflate = (base64) => new Response(new Blob([decode(base64)]).stream().pipeThrough(new DecompressionStream("gzip")));
// The viewer's PDF.js worker, inflated once when PDF.js first asks, as a data: URL: a module worker
// started from a file:// page cannot load a blob:null one.
let viewerWorker;
globalThis.AUTHORITIES_PDF_WORKER_URL = () => viewerWorker ??= inflate(payload.viewerPdfWorker).blob()
  .then((blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([blob], { type: "text/javascript" }));
  }));
// PDF.js's image decoders, by file name, as data: URLs for the viewer and the recognizer alike.
let decoders;
globalThis.AUTHORITIES_PDF_DECODERS = () => decoders ??= Promise.all(Object.entries(payload.pdfDecoders)
  .map(async ([name, packed]) => [name, await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    inflate(packed).blob().then((blob) => reader.readAsDataURL(new Blob([blob], { type: "application/wasm" })), reject);
  })])).then(Object.fromEntries);
// Ready before the first PDF opens, once the page is idle.
(globalThis.requestIdleCallback ?? setTimeout)(() => globalThis.AUTHORITIES_PDF_WORKER_URL().catch(() => {}));

const pending = new Map();
const recognition = new Map();
let nextId = 0, failure = null;
// The runtime is carried gzipped: it is inflated off the main thread, then started as its Worker.
const runtimeCode = inflate(payload.runtime).blob();
function startRuntime(name) {
let worker;
const ready = runtimeCode.then((code) => new Promise((resolve, reject) => {
  const workerUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  worker = new Worker(workerUrl, { name });
  const stop = (message) => {
    // Before start-up this rejects `ready`; afterwards it ends every open request.
    URL.revokeObjectURL(workerUrl);
    for (const controller of recognition.values()) controller.abort();
    recognition.clear();
    failure = new Error(`Authorities stopped working: ${message}. Reload the page to continue.`);
    reject(failure);
    for (const request of [...pending.values()]) request.fail(failure);
  };
  worker.onerror = (event) => stop(event.message);
  worker.onmessage = ({ data }) => {
    if (data.type === "cancel-recognition") { recognition.get(data.id)?.abort(); return; }
    if (data.type === "recognize") {
      const controller = new AbortController(); recognition.set(data.id, controller);
      recognizePdf(data.bytes, data.sourceSha256, data.pages, controller.signal,
        recognized => worker.postMessage({ type: 'recognize-progress', id: data.id, recognized })).then(
        result => worker.postMessage({ type: 'recognized', id: data.id, result }),
        error => worker.postMessage({ type: 'recognized', id: data.id, error: error.message })).finally(() => recognition.delete(data.id));
      return;
    }
    // Publisher PDFs kept by the page's own store (registered by the workspace), by URL and hash.
    if (data.type === "source-pdf") {
      Promise.resolve(globalThis.AUTHORITIES_SOURCE_PDFS?.read(data.url)).catch(() => null).then((bytes) =>
        worker.postMessage({ type: "source-pdf", id: data.id, bytes: bytes ?? null }, bytes ? [bytes.buffer] : []));
      return;
    }
    // The engine's parse cache, kept by source hash for later visits.
    if (data.type === "parse-cache") {
      if (data.op === "put") { writeParseCache(data.sha256, data.files); return; }
      readParseCache(data.sha256).then((files) => worker.postMessage({ type: "parse-cache", id: data.id, files },
        (files ?? []).map(([, content]) => content.buffer)));
      return;
    }
    if (data.type === "source-pdf-fetched") {
      Promise.resolve(globalThis.AUTHORITIES_SOURCE_PDFS?.remember(data.url, data.sha256)).catch(() => {});
      return;
    }
    // Answers sources gave to lookups, kept by the page's store until they expire.
    if (data.type === "source-answer") {
      Promise.resolve(globalThis.AUTHORITIES_SOURCE_ANSWERS?.read(data.url)).catch(() => null).then((body) =>
        worker.postMessage({ type: "source-answer", id: data.id, body: body ?? null }));
      return;
    }
    if (data.type === "source-answer-fetched") {
      Promise.resolve(globalThis.AUTHORITIES_SOURCE_ANSWERS?.remember(data.url, data.body, data.expires)).catch(() => {});
      return;
    }
    if (data.type === "ready") { URL.revokeObjectURL(workerUrl); return resolve(); }
    if (data.type === "failed") return stop(data.message);
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "progress") request.progress?.(data.message);
    else if (data.type === "quote-progress") request.quoteProgress?.(data.value);
    else if (data.type === "result") request.resolve(data.result);
    else if (data.type === "error") request.fail(Object.assign(new Error(data.message), { status: data.status }));
  };
  worker.postMessage({ type: "init", engine: payload.engine });
}));
ready.catch(() => { /* each request reports it */ });
return { ready, post: (message, transfer) => worker.postMessage(message, transfer) };
}
const runtime = startRuntime("authorities-runtime");
// The book's cover and index previews are drawn by a runtime of their own, started when the first is
// asked for, so a preview never waits behind a brief being read.
let previews;
const runtimeFor = (operation) => operation === "book-front" ? previews ??= startRuntime("authorities-previews") : runtime;

globalThis.AUTHORITIES_OPERATIONS = async (operation, input, { signal, progress, quoteProgress } = {}) => {
  signal?.throwIfAborted();
  const { ready, post } = runtimeFor(operation);
  await ready;
  signal?.throwIfAborted();
  if (failure) throw failure;
  const id = ++nextId;
  let built;
  if (operation === "build") holdBackground(new Promise(resolve => { built = resolve; }));
  return new Promise((resolve, reject) => {
    const finish = () => { pending.delete(id); signal?.removeEventListener("abort", onAbort); built?.(); };
    const onAbort = () => { post({ type: "abort", id }); finish(); reject(new DOMException("The operation was aborted.", "AbortError")); };
    pending.set(id, { progress, quoteProgress,
      resolve: result => { finish(); resolve(result); }, fail: error => { finish(); reject(error); } });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      post({ type: "operation", id, operation, input }, (input.files ?? []).map(file => file.bytes.buffer));
    } catch (error) { pending.get(id)?.fail(error); }
  });
};

/** The page-relative path the loopback server would see, or null for another site.
 *  From a Windows file the workspace's "/api/..." resolves to file:///C:/api/...:
 *  file URLs keep the drive letter, so it is not part of the route. */
function localRoute(url, page) {
  if (url.protocol === "file:") return url.pathname.replace(/^\/[A-Za-z]:(?=\/)/u, "");
  return url.origin === page.origin ? url.pathname : null;
}

const fonts = new Map(Object.entries(payload.fonts));
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  const route = localRoute(url, location);
  if (route?.startsWith(FONTS)) {
    const font = fonts.get(route.slice(FONTS.length));
    // The fonts are carried gzipped and inflated as PDF.js asks for each.
    return font ? inflate(font) : new Response(null, { status: 404 });
  }
  // A browser cannot read other local files; say which one instead of "Failed to fetch".
  if (url.protocol === "file:") return new Response(JSON.stringify({ detail: `Authorities has no file at ${route}` }),
    { status: 404, headers: { "Content-Type": "application/json" } });
  return nativeFetch(input, init);
};
