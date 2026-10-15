import { inflateAsset } from "../browser-ocr/packed-asset.mjs";
// The shared Authorities application operations, called directly from the page worker.
import { Buffer } from "buffer";
import fs from "./node/fs.mjs";
import { ENGINE_PATH, process } from "./node/globals.mjs";
import { createWasi } from "./wasi.mjs";
import { mounted } from "node:sqlite";
import { createStructureAddon } from "./structure-addon.mjs";
import { ApplicationError } from "../../../backend/src/lib/applicationError";
import { createAuthoritiesOperations } from "../../../backend/src/lib/authoritiesOperations";
import { authoritySourceServices, resolveAuthoritiesSources } from "../../../backend/src/lib/authoritiesSourceResolution";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { keptPdf, pageAnswered } from "./source-pdf-cache.mjs";
import { parseCacheAnswered, pdfParser } from "./pdf-parse-pool.mjs";


// structureNative() loads its engine through process.dlopen: here, the same crate compiled
// for WASI, compiled when the runtime first handles document work.
let engineModule, engineAsset, engineReady;
let recognitionId = 0;
const recognition = new Map();
function recognizePdf(bytes, sourceSha256, pages, signal, completed) {
  const id = ++recognitionId;
  return new Promise((resolve, reject) => {
    const abort = () => {
      recognition.delete(id);
      self.postMessage({ type: 'cancel-recognition', id });
      reject(new DOMException('Recognition cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    recognition.set(id, { resolve, reject, completed, cleanup: () => signal?.removeEventListener('abort', abort) });
    const copy = new Uint8Array(bytes);
    self.postMessage({ type: 'recognize', id, bytes: copy, sourceSha256, pages }, [copy.buffer]);
  });
}
process.dlopen = (module, filename) => {
  if (filename !== ENGINE_PATH || !engineModule) throw new Error(`Cannot load ${filename}`);
  module.exports = createStructureAddon(() => {
    let stderr = "";
    const wasi = createWasi(fs, { stderr: (text) => { stderr = `${stderr}\n${text}`.slice(-4_000); },
      // The PDF parse cache lives in this tab's memory, not on a disk: keep it small.
      env: { LEGALPDF_CACHE_MAX_BYTES: String(64 * 1024 * 1024) },
      // The engine reads the stores the user picked (the A2AJ store) itself.
      mounted });
    const instance = new WebAssembly.Instance(engineModule, wasi.imports);
    wasi.initialize(instance);
    // The panic hook writes "thread ... panicked at file:line:\nmessage".
    return { instance, close: wasi.close,
      panic: () => stderr.split(/panicked at [^\n]*\n/u).at(-1).trim().split("\n")[0] ?? "" };
  }, (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), recognizePdf, pdfParser);
};

async function loadEngine(asset) {
  engineModule = await WebAssembly.compile(await (await inflateAsset(asset)).arrayBuffer());
  pdfParser.start(engineModule);
  // structureNative() checks that its engine file exists before loading it.
  fs.mkdirSync("/engine", { recursive: true });
  fs.writeFileSync(ENGINE_PATH, "");
}
let operations;
const active = new Map();
async function handle({ id, operation, input }) {
  const controller = new AbortController();
  active.set(id, controller);
  try {
    if (!["mount-store", "alr-model", "alr-source-keys"].includes(operation)) await (engineReady ??= loadEngine(engineAsset));
    controller.signal.throwIfAborted();
    const result = await operations[operation](input, { signal: controller.signal,
      progress: message => self.postMessage({ type: "progress", id, message }),
      quoteProgress: value => self.postMessage({ type: "quote-progress", id, value }) });
    controller.signal.throwIfAborted();
    // Each result owns its outgoing copies; moving them cannot detach cached native buffers.
    const outgoing = { ...result, files: result.files?.map(file => ({ ...file, bytes: Uint8Array.from(file.bytes) })),
      attachments: result.attachments?.map(file => ({ ...file, bytes: Uint8Array.from(file.bytes) })) };
    self.postMessage({ type: "result", id, result: outgoing },
      [...outgoing.files ?? [], ...outgoing.attachments ?? []].map(file => file.bytes.buffer));
  } catch (error) {
    if (!controller.signal.aborted) {
      const status = error instanceof ApplicationError ? error.status : 500;
      if (status === 500) console.error(error);
      self.postMessage({ type: "error", id, status, message: status === 500
        ? "Authorities could not complete that operation" : error.message });
    }
  } finally { active.delete(id); }
}

self.onmessage = async ({ data }) => {
  if (data.type === "source-pdf" || data.type === "source-answer") pageAnswered(data);
  else if (data.type === "parse-cache") parseCacheAnswered(data);
  else if (data.type === "recognize-progress") recognition.get(data.id)?.completed?.(data.recognized);
  else if (data.type === "recognized") {
    const pending = recognition.get(data.id);
    if (!pending) return;
    recognition.delete(data.id); pending.cleanup();
    data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
  } else if (data.type === "init") {
    try {
      if (__NETWORK__ && data.providerServiceUrl) process.env.ALR_PROVIDER_SERVICE_URL = data.providerServiceUrl;
      if (__NETWORK__ && data.pdfServiceUrl) process.env.ALR_PDF_SERVICE_URL = data.pdfServiceUrl;
      engineAsset = data.engine;
      // A publisher's original the page kept from an earlier fetch stands in for one it blocked now.
      const sources = { ...authoritySourceServices, stored: keptPdf };
      operations = createAuthoritiesOperations((draft, _sources, signal, authorityId, progress, keptOnly) =>
        resolveAuthoritiesSources(draft, sources, signal, authorityId, progress, keptOnly, __CASE_MISMATCH_MODE__));
      // A page built with local stores (runtime-bundle.mjs) gives the runtime the files it reads them from.
      if (__LOCAL_STORES__) operations["mount-store"] = (await import("./local-stores.mjs")).mountStore;
    } catch (error) {
      // A rejected handler does not reach the page's onerror; say so, or every request waits.
      self.postMessage({ type: "failed", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    self.postMessage({ type: "ready" });
  } else if (data.type === "operation") {
    void handle(data);
  } else if (data.type === "abort") {
    active.get(data.id)?.abort();
  }
};
