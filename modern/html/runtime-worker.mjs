// The Authorities runtime in a Web Worker: the router the loopback server mounts
// (backend/src/authoritiesStandaloneServer.ts), answered in the page instead of on 127.0.0.1.
import EventEmitter from "events";
import { Buffer } from "buffer";
import fs from "./node/fs.mjs";
import { ENGINE_PATH, process } from "./node/globals.mjs";
import { createWasi } from "./wasi.mjs";
import { createStructureAddon, warmStructureAddon } from "./structure-addon.mjs";
import { ApplicationError } from "../../../backend/src/lib/applicationError";
import { createAuthoritiesRuntimeRouter } from "../../../backend/src/routes/authoritiesRuntime";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { pageAnswered } from "./source-pdf-cache.mjs";
import { parseCacheAnswered, pdfParser } from "./pdf-parse-pool.mjs";

const PREFIX = "/api/authorities-runtime";

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
const STANDALONE_USER = "00000000-0000-0000-0000-000000000001";
let router;
const active = new Map();

function accepts(header, type) {
  const accepted = String(header ?? "*/*").split(",").map((part) => part.split(";")[0].trim());
  return accepted.some((value) => value === type || value === "*/*" ||
    (value.endsWith("/*") && type.startsWith(value.slice(0, -1)))) ? type : false;
}

function createResponse(id) {
  const response = new EventEmitter();
  response.id = id;
  const headers = {};
  const post = (message, transfer) => self.postMessage({ id, ...message }, transfer ?? []);
  const start = () => {
    if (response.headersSent) return;
    response.headersSent = true;
    post({ type: "head", status: response.statusCode, headers });
  };
  const bytes = (chunk) => typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  Object.assign(response, {
    statusCode: 200, headersSent: false, writableEnded: false, locals: {},
    status(code) { response.statusCode = code; return response; },
    setHeader(name, value) { headers[name.toLowerCase()] = String(value); return response; },
    getHeader: (name) => headers[name.toLowerCase()],
    set(name, value) { return response.setHeader(name, value); },
    type(value) { return response.setHeader("content-type", value); },
    flushHeaders: start,
    write(chunk) {
      start();
      const view = bytes(chunk), out = Uint8Array.prototype.slice.call(view);
      post({ type: "chunk", bytes: out }, [out.buffer]);
      return true;
    },
    end(chunk) {
      if (response.writableEnded) return response;
      if (chunk !== undefined && chunk !== null) response.write(chunk); else start();
      response.writableEnded = true;
      post({ type: "end" });
      active.delete(id);
      response.emit("finish"); response.emit("close");
      return response;
    },
    json(value) {
      if (!headers["content-type"]) response.setHeader("content-type", "application/json; charset=utf-8");
      return response.end(JSON.stringify(value));
    },
    send(value) {
      return typeof value === "object" && !(value instanceof Uint8Array) ? response.json(value) : response.end(value);
    },
  });
  return response;
}

// Mirrors the loopback server's error handler. A response already under way is broken
// off, as the server destroys its socket, so the page does not read it as complete. A
// defect is logged; a request the page itself abandoned is not one.
function fail(response, error) {
  if (response.headersSent) {
    if (response.writableEnded) return;
    if (!response.abandoned) console.error(error);
    response.writableEnded = true; active.delete(response.id);
    self.postMessage({ id: response.id, type: "error", message: "Authorities stopped part-way through this response." });
    response.emit("close");
    return;
  }
  const status = error instanceof ApplicationError ? error.status : 500;
  if (status === 500 && !response.abandoned) console.error(error);
  response.status(status).json({ detail: status === 500
    ? "Authorities could not complete that operation" : error.message });
}

async function handle({ id, method, path, headers, body, json, form }) {
  const response = createResponse(id);
  active.set(id, response);
  if (json !== undefined) {
    try { body = JSON.parse(json); }
    catch { return response.status(400).json({ detail: "The request body is not valid JSON." }); }
  }
  const request = {
    method, path: path.slice(PREFIX.length) || "/", url: path, originalUrl: path, headers,
    body: body === undefined ? {} : body, get: (name) => headers[name.toLowerCase()],
    header: (name) => headers[name.toLowerCase()], accepts: (type) => accepts(headers.accept, type),
  };
  if (form) request.formParts = await Promise.all(form.map(async ([name, value]) =>
    [name, typeof value === "string" ? value
      : { name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) }]));
  router.handle(request, response, (error) => {
    if (error) return fail(response, error);
    if (!response.headersSent) response.status(404).json({ detail: "Not found" });
  });
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
      router = createAuthoritiesRuntimeRouter((_request, response, next) => {
        response.locals.userId = STANDALONE_USER; next();
      });
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
  } else if (data.type === "request") {
    handle(data).catch((error) => fail(active.get(data.id) ?? createResponse(data.id), error));
  } else if (data.type === "abort") {
    const response = active.get(data.id);
    if (response) { response.abandoned = true; response.emit("close"); }
  }
};
