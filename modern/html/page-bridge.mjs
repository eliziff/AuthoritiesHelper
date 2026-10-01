import { holdBackground, recognizePdf, readRecognizedText, recognitionWaiting } from './recognize-pdf.mjs';
import { readParseCache, writeParseCache } from './parse-cache-store.mjs';
// Runs before the Authorities workspace in the self-contained HTML. It starts the
// runtime Worker and answers the requests the loopback server would: the runtime
// API and the PDF.js standard fonts. Everything else goes to the network as usual.
/* global __AUTHORITIES_PAYLOAD__ */

const API = "/api/authorities-runtime/";
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
const decode = (base64) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

const worker = new Worker(URL.createObjectURL(new Blob([payload.runtime], { type: "text/javascript" })),
  { name: "authorities-runtime" });
const pending = new Map();
const recognition = new Map();
let nextId = 0, failure = null;
const ready = new Promise((resolve, reject) => {
  const stop = (message) => {
    // Before start-up this rejects `ready`; afterwards it ends every open request.
    failure = new Error(`Authorities stopped working: ${message}. Reload the page to continue.`);
    reject(failure);
    for (const request of pending.values()) request.fail(failure);
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
    if (data.type === "ready") return resolve();
    if (data.type === "failed") return stop(data.message);
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "head") request.head(data);
    else if (data.type === "chunk") request.chunk(data.bytes);
    else if (data.type === "end") request.end();
    else if (data.type === "error") request.fail(new Error(data.message));
  };
  worker.postMessage({ type: "init", engine: payload.engine, relayUrl: payload.relayUrl });
});
ready.catch(() => { /* each request reports it */ });

/** The body as the Worker takes it. A FormData or string the caller built is passed as is,
 *  rather than re-encoded and parsed again on this thread; JSON is parsed in the Worker. */
async function encodeBody(request, init) {
  const type = request.headers.get("content-type") ?? "", supplied = init?.body;
  if (supplied instanceof FormData) return { form: [...supplied] };
  if (type.startsWith("multipart/form-data")) return { form: [...await request.formData()] };
  const text = typeof supplied === "string" ? supplied : await request.text();
  if (!text) return {};
  return type.includes("json") ? { json: text } : { body: text };
}

const aborted = () => new DOMException("The operation was aborted.", "AbortError");

async function runtimeFetch(request, path, init) {
  const { signal } = request;
  if (signal.aborted) throw aborted();
  await ready;
  if (failure) throw failure;
  const encoded = await encodeBody(request, init);
  if (signal.aborted) throw aborted();
  const id = ++nextId;
  let built;
  // A build is waited on: recognition it does not need waits until it is done.
  if (path === `${API}build`) holdBackground(new Promise((resolve) => { built = resolve; }));
  return new Promise((resolve, reject) => {
    let controller;
    const finish = () => { pending.delete(id); signal.removeEventListener("abort", onAbort); built?.(); };
    const fail = (error) => {
      finish(); reject(error);
      try { controller.error(error); } catch { /* already closed */ }
    };
    const onAbort = () => { worker.postMessage({ type: "abort", id }); fail(aborted()); };
    const body = new ReadableStream({ start: (value) => { controller = value; },
      cancel: () => { worker.postMessage({ type: "abort", id }); finish(); } });
    signal.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      head: ({ status, headers }) => resolve(new Response(
        [101, 204, 205, 304].includes(status) ? null : body, { status, headers })),
      chunk: (bytes) => { try { controller.enqueue(bytes); } catch { /* reader cancelled */ } },
      end: () => { finish(); try { controller.close(); } catch { /* reader cancelled */ } },
      fail,
    });
    worker.postMessage({ type: "request", id, method: request.method, path,
      headers: Object.fromEntries(request.headers), ...encoded });
  });
}

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
  // A Request is only built for the runtime: building one reads the body of a Request input.
  if (route?.startsWith(API)) return runtimeFetch(new Request(input, init), route, init);
  if (route?.startsWith(FONTS)) {
    const font = fonts.get(route.slice(FONTS.length));
    return font ? new Response(decode(font)) : new Response(null, { status: 404 });
  }
  // A browser cannot read other local files; say which one instead of "Failed to fetch".
  if (url.protocol === "file:") return new Response(JSON.stringify({ detail: `Authorities has no file at ${route}` }),
    { status: 404, headers: { "Content-Type": "application/json" } });
  return nativeFetch(input, init);
};
