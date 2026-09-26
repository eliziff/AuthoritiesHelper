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
  return new Promise((resolve, reject) => {
    let controller;
    const finish = () => { pending.delete(id); signal.removeEventListener("abort", onAbort); };
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
