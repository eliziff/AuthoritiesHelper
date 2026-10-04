// The shared Authorities application operations, called directly from the page worker.
import { Buffer } from "buffer";
import fs from "./node/fs.mjs";
import { ENGINE_PATH, process } from "./node/globals.mjs";
import { createWasi } from "./wasi.mjs";
import { createStructureAddon, warmStructureAddon } from "./structure-addon.mjs";
import { ApplicationError } from "../../../backend/src/lib/applicationError";
import { createAuthoritiesOperations } from "../../../backend/src/lib/authoritiesOperations";
import { sourcePageLabelsOperation } from "../../../backend/src/lib/authoritiesPageLabels";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { pageAnswered } from "./source-pdf-cache.mjs";
import { parseCacheAnswered, pdfParser } from "./pdf-parse-pool.mjs";


// structureNative() loads its engine through process.dlopen: here, the same crate compiled
// for WASI, compiled once when the runtime starts.
let engineModule;
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
      env: { LEGALPDF_CACHE_MAX_BYTES: String(64 * 1024 * 1024) } });
    const instance = new WebAssembly.Instance(engineModule, wasi.imports);
    wasi.initialize(instance);
    // The panic hook writes "thread ... panicked at file:line:\nmessage".
    return { instance, close: wasi.close,
      panic: () => stderr.split(/panicked at [^\n]*\n/u).at(-1).trim().split("\n")[0] ?? "" };
  }, (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), recognizePdf, pdfParser);
};

async function loadEngine(base64) {
  const gzipped = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  const stream = new Blob([gzipped]).stream().pipeThrough(new DecompressionStream("gzip"));
  engineModule = await WebAssembly.compile(await new Response(stream).arrayBuffer());
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
      await loadEngine(data.engine);
      operations = { ...createAuthoritiesOperations(), "source-page-labels": sourcePageLabelsOperation };
    } catch (error) {
      // A rejected handler does not reach the page's onerror; say so, or every request waits.
      self.postMessage({ type: "failed", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    self.postMessage({ type: "ready" });
    // Ready the engine and a PDF parser now, while the user chooses a file, not during their first import.
    // The parser starts first: its Worker cannot receive the engine while this thread is busy.
    pdfParser.warm().then(() => {
      try { warmStructureAddon(structureNative()); } catch (error) { console.error(error); }
    });
  } else if (data.type === "operation") {
    void handle(data);
  } else if (data.type === "abort") {
    active.get(data.id)?.abort();
  }
};
