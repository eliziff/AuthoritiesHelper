// The Authorities runtime in a Web Worker: the router the loopback server mounts
// (backend/src/authoritiesStandaloneServer.ts), answered in the page instead of on 127.0.0.1.
import EventEmitter from "events";
import { Buffer } from "buffer";
import fs from "./node/fs.mjs";
import { ENGINE_PATH, process } from "./node/globals.mjs";
import { createWasi } from "./wasi.mjs";
import { createStructureAddon } from "./structure-addon.mjs";
import { ApplicationError } from "../../../backend/src/lib/applicationError";
import { createAuthoritiesRuntimeRouter } from "../../../backend/src/routes/authoritiesRuntime";

const PREFIX = "/api/authorities-runtime";

// structureNative() loads its engine through process.dlopen: here, the same crate compiled for WASI.
process.dlopen = (module, filename) => {
  const wasi = createWasi(fs);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(filename)), wasi.imports);
  wasi.initialize(instance);
  module.exports = createStructureAddon(instance,
    (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
};
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
      const out = new Uint8Array(bytes(chunk)).slice();
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

// Mirrors the loopback server's error handler.
function fail(response, error) {
  if (response.headersSent) return response.end();
  const status = error instanceof ApplicationError ? error.status : 500;
  if (status === 500) console.error(error);
  response.status(status).json({ detail: status === 500
    ? "Authorities could not complete that operation" : error.message });
}

async function handle({ id, method, path, headers, body, form }) {
  const response = createResponse(id);
  active.set(id, response);
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
  if (data.type === "init") {
    fs.mkdirSync("/engine", { recursive: true });
    fs.writeFileSync(ENGINE_PATH, new Uint8Array(data.engine));
    globalThis.AUTHORITIES_RELAY_URL = data.relayUrl;
    router = createAuthoritiesRuntimeRouter((_request, response, next) => {
      response.locals.userId = STANDALONE_USER; next();
    });
    self.postMessage({ type: "ready" });
  } else if (data.type === "request") {
    handle(data).catch((error) => fail(active.get(data.id) ?? createResponse(data.id), error));
  } else if (data.type === "abort") {
    active.get(data.id)?.emit("close");
  }
};
