// The Authorities runtime of a desktop program, run in the program's own process with the native legal-structure
// engine (the addon structureNative() loads): what ../html/page-bridge.mjs otherwise starts as a browser Worker, with
// the same messages. The page posts its messages to /runtime/send and asks /runtime/poll for the runtime's, a request
// held until there are some; both travel the window's request pipe (launch.mjs), and bytes travel as bytes
// (../html/runtime-frames.mjs). The runtime stays loaded while the program runs.
//
// A page's lookups ask the page for what its own store keeps (publisher PDFs and sources' answers,
// ../html/source-pdf-cache.mjs). The native engine recognizes scanned pages; the program answers the
// legal source and publisher PDF services' requests itself (`local`). Bundle with runtime-plugin.mjs.
import { ApplicationError } from "../../../backend/src/lib/applicationError";
import { authoritySourceServices, resolveAuthoritiesSources } from "../../../backend/src/lib/authoritiesSourceResolution";
import { reachForeignCaseHosts } from "../../../backend/src/lib/legalSources";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { decodeFrame, encodeFrame } from "../html/runtime-frames.mjs";
import { keptPdf, pageAnswered, usePage } from "../html/source-pdf-cache.mjs";
import { useServiceFetch } from "../html/undici.mjs";
import { useServedFiles } from "./node-sqlite.mjs";

// A poll is answered within the window's wait for any answer (120 seconds).
const HOLD_MS = 50_000;
// A program built without the US and UK publishers' hosts (../html/undici.mjs) looks for no decision there.
reachForeignCaseHosts(__UK_CASE_LAW__);
const bytes = (frame, offset, length) => Buffer.from(frame.buffer, frame.byteOffset + offset, length);

/**
 * @param createOperations the operations' factory (Beaver's createAuthoritiesOperations, or an app's), given its
 *   sources' resolver
 * @param mountStore the "mount-store" operation, when the page has local stores (native-stores.mjs, or an app's)
 * @param caseMismatch what the sources' resolver does with a different case than cited ("resolve" or "warn")
 * @param origin the page's origin; `local(request)` answers the program's requests at it
 * @param servedFile(url) where a file the program serves lies: `{ path, offset, size, mtimeMs }`, or null
 */
export function createNativeRuntime({ createOperations, mountStore, caseMismatch = "resolve", origin, local, servedFile }) {
  process.env.ALR_PROVIDER_SERVICE_URL = new URL("/source", origin).href;
  process.env.ALR_PDF_SERVICE_URL = new URL("/pdf", origin).href;
  useServiceFetch((url, init = {}) => {
    if (new URL(url).origin !== origin) return fetch(url, init);
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    return local(new Request(url, { ...init, headers }));
  });
  useServedFiles((url) => { try { const at = new URL(url); return at.origin === origin ? servedFile(at.pathname) : null; } catch { return null; } });

  // The page now open; a reload starts another, and what the last one asked for ends.
  let page = null;
  const post = (session, message) => {
    if (session !== page) return false;
    // A step's progress the page has not yet been sent is said by the next one: each answer costs the window a request.
    if (message.type === "progress") {
      const earlier = session.queue.findIndex((queued) => queued.type === "progress" && queued.id === message.id);
      if (earlier >= 0) session.queue.splice(earlier, 1);
    }
    session.queue.push(message);
    session.waiting?.();
    return true;
  };
  usePage((message) => {
    // Nothing kept is known when no page is open to ask.
    if (!post(page, message) && message.id !== undefined) pageAnswered({ id: message.id });
  });
  let operations;
  function load() {
    if (operations) return operations;
    // A publisher's original the page kept from an earlier fetch stands in for one it blocked now.
    const sources = { ...authoritySourceServices, stored: keptPdf };
    operations = createOperations((draft, _sources, signal, authorityId, progress, keptOnly) =>
      resolveAuthoritiesSources(draft, sources, signal, authorityId, progress, keptOnly, caseMismatch));
    if (mountStore) operations["mount-store"] = mountStore;
    // The engine loads with the runtime, not with the first document.
    structureNative();
    return operations;
  }

  async function run(session, { id, operation, input }) {
    const controller = new AbortController();
    session.active.set(id, controller);
    try {
      const operations = load();
      if (!Object.hasOwn(operations, operation)) throw new ApplicationError(400, "Unknown Authorities operation.");
      const result = await operations[operation](input, { signal: controller.signal,
        progress: (message) => post(session, { type: "progress", id, message }),
        quoteProgress: (value) => post(session, { type: "quote-progress", id, value }) });
      controller.signal.throwIfAborted();
      post(session, { type: "result", id, result });
    } catch (error) {
      if (!controller.signal.aborted) {
        const status = error instanceof ApplicationError ? error.status : 500;
        if (status === 500) console.error(error);
        post(session, { type: "error", id, status, message: status === 500
          ? "Authorities could not complete that operation" : error.message });
      }
    } finally { session.active.delete(id); }
  }

  function receive(session, message) {
    if (message.type === "init") {
      try { load(); post(session, { type: "ready" }); }
      catch (error) { post(session, { type: "failed", message: error instanceof Error ? error.message : String(error) }); }
    } else if (message.type === "operation") void run(session, message);
    else if (message.type === "abort") session.active.get(message.id)?.abort();
    else if (message.type === "source-pdf" || message.type === "source-answer") pageAnswered(message);
  }

  const closed = new Set();
  function open(id) {
    if (!/^[0-9a-f-]{36}$/u.test(id ?? "")) throw new ApplicationError(400, "This runtime request names no page.");
    if (page?.id === id) return page;
    if (closed.has(id)) throw new ApplicationError(409, "Another page opened the runtime.");
    // The page that opens now is the one the runtime serves; what the last one asked for ends.
    if (page) {
      closed.add(page.id);
      for (const controller of page.active.values()) controller.abort();
      page.waiting?.();
    }
    return page = { id, queue: [], waiting: null, active: new Map() };
  }

  /** Answers the page's request at /runtime/…; anything else is not the runtime's. */
  async function handle(request) {
    const url = new URL(request.url);
    const session = open(url.searchParams.get("session"));
    if (url.pathname === "/runtime/send" && request.method === "POST") {
      const messages = decodeFrame(new Uint8Array(await request.arrayBuffer()), bytes);
      if (!Array.isArray(messages)) throw new ApplicationError(400, "A runtime message is a list.");
      for (const message of messages) if (message && typeof message === "object") receive(session, message);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/runtime/poll" && request.method === "GET") {
      if (!session.queue.length && page === session) await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); request.signal.removeEventListener("abort", done); session.waiting = null; resolve(); };
        const timer = setTimeout(done, HOLD_MS);
        session.waiting?.();
        session.waiting = done;
        request.signal.addEventListener("abort", done, { once: true });
      });
      if (page !== session) return new Response("Another page opened the runtime.", { status: 409 });
      if (!session.queue.length) return new Response(null, { status: 204 });
      return new Response(encodeFrame(session.queue.splice(0)), { headers: {
        "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
    }
    throw new ApplicationError(404, "Not found.");
  }
  return { handle };
}
