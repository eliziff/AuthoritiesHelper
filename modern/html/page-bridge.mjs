// Runs before the Authorities workspace in the self-contained HTML. It starts the
// runtime Worker and answers the requests the loopback server would: the runtime
// API and the PDF.js standard fonts. Everything else goes to the network as usual.
/* global __AUTHORITIES_PAYLOAD__ */

const API = "/api/authorities-runtime/";
const FONTS = "/pdfjs-standard-fonts/";
const payload = __AUTHORITIES_PAYLOAD__;
const decode = (base64) => Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

const worker = new Worker(URL.createObjectURL(new Blob([payload.runtime], { type: "text/javascript" })),
  { name: "authorities-runtime" });
const pending = new Map();
let nextId = 0;
const ready = new Promise((resolve, reject) => {
  worker.onerror = (event) => reject(new Error(`Authorities could not start: ${event.message}`));
  worker.onmessage = ({ data }) => {
    if (data.type === "ready") return resolve();
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "head") request.head(data);
    else if (data.type === "chunk") request.controller.enqueue(data.bytes);
    else if (data.type === "end") { pending.delete(data.id); request.controller.close(); }
  };
  const engine = decode(payload.engine).buffer;
  worker.postMessage({ type: "init", engine, relayUrl: payload.relayUrl }, [engine]);
});

async function encodeBody(request) {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) return { form: [...await request.formData()] };
  const text = await request.text();
  if (!text) return {};
  return { body: type.includes("json") ? JSON.parse(text) : text };
}

async function runtimeFetch(request, path) {
  await ready;
  const id = ++nextId, message = { type: "request", id, method: request.method, path,
    headers: Object.fromEntries(request.headers), ...await encodeBody(request) };
  return new Promise((resolve, reject) => {
    let controller;
    const body = new ReadableStream({ start: (value) => { controller = value; },
      cancel: () => worker.postMessage({ type: "abort", id }) });
    pending.set(id, { controller, head: ({ status, headers }) => resolve(new Response(
      [101, 204, 205, 304].includes(status) ? null : body, { status, headers })) });
    request.signal?.addEventListener("abort", () => {
      worker.postMessage({ type: "abort", id }); pending.delete(id);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
    worker.postMessage(message);
  });
}

const fonts = new Map(Object.entries(payload.fonts));
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.protocol === "file:" || url.origin === location.origin) {
    if (url.pathname.startsWith(API)) return runtimeFetch(request, url.pathname);
    if (url.pathname.startsWith(FONTS)) {
      const font = fonts.get(url.pathname.slice(FONTS.length));
      return font ? new Response(decode(font)) : new Response(null, { status: 404 });
    }
  }
  return nativeFetch(input, init);
};
