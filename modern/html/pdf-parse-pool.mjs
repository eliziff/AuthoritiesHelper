// PDFs are parsed in Workers beside the runtime (parse-worker.mjs), a few at once, and the
// parse cache they write is kept by source hash: in this runtime's filesystem, where its own
// engine reads documents from it, and in the page's store, so a later visit does not parse
// the same PDF again. A Worker left idle is closed, and the memory its parse used with it.
/* global __PARSE_WORKER__ */
import fs from "./node/fs.mjs";

const PARSERS = Math.max(1, Math.min(2, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 4)));
const IDLE_MS = 30_000;
// Kept in this runtime's memory; the page's store keeps more, and a parse refills from it.
const MEMORY_LIMIT = 32 * 1024 * 1024;
// A parser whose engine has grown past this (its memory never shrinks) is closed once its parse is
// done, and the next parse starts on a fresh one.
const PARSER_MEMORY_LIMIT = 256 * 1024 * 1024;

let engine, source;
const idle = [], queue = [];
let running = 0;

function spawn() {
  source ??= URL.createObjectURL(new Blob([__PARSE_WORKER__], { type: "text/javascript" }));
  const worker = new Worker(source, { name: "authorities-pdf-parse" });
  // Its first message says it has the engine, which needs this thread free to deliver it.
  worker.started = new Promise((resolve) => {
    worker.addEventListener("message", resolve, { once: true });
    worker.addEventListener("error", resolve, { once: true });
  });
  worker.postMessage({ module: engine });
  return worker;
}

// A parser that has read a PDF is closed when left idle, with the memory its engine holds (over
// 100 MB once readied); the next PDF starts one. The one readied as the page opens waits for the
// first PDF.
function park(worker, fresh = false) {
  const parked = { worker, timer: fresh ? undefined : setTimeout(() => {
    idle.splice(idle.indexOf(parked), 1); worker.terminate();
  }, IDLE_MS) };
  idle.push(parked);
}

function run(job) {
  return new Promise((resolve, reject) => {
    const entry = { job, resolve, reject };
    const abort = () => {
      reject(job.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      const queued = queue.indexOf(entry);
      if (queued >= 0) { queue.splice(queued, 1); return; }
      // A parse under way cannot be interrupted; its Worker is closed instead.
      entry.worker.onmessage = entry.worker.onerror = null;
      entry.worker.terminate();
      running -= 1; drain();
    };
    job.signal?.addEventListener("abort", abort, { once: true });
    entry.done = () => job.signal?.removeEventListener("abort", abort);
    queue.push(entry); drain();
  });
}

function drain() {
  while (running < PARSERS && queue.length) {
    const entry = queue.shift(), { job } = entry;
    const parked = idle.pop();
    clearTimeout(parked?.timer);
    const worker = entry.worker = parked?.worker ?? spawn();
    running += 1;
    const finish = (settle) => {
      worker.onmessage = worker.onerror = null;
      entry.done();
      running -= 1;
      settle();
      if (worker.healthy) park(worker); else worker.terminate();
      drain();
    };
    worker.healthy = true;
    worker.onmessage = ({ data }) => data.started || finish(() => {
      if (data.memory > PARSER_MEMORY_LIMIT) worker.healthy = false;
      data.error ? entry.reject(new Error(data.error)) : entry.resolve(data);
    });
    worker.onerror = (event) => {
      event.preventDefault?.(); worker.healthy = false;
      finish(() => entry.reject(new Error(event.message || "The PDF parser stopped.")));
    };
    // What earlier parses of this source left, as copies: the filesystem keeps its own buffers.
    const cache = [...kept.get(job.sha256) ?? []].filter((path) => fs.existsSync(path))
      .map((path) => [path, new Uint8Array(fs.readFileSync(path))]);
    worker.postMessage({ id: 1, bytes: job.bytes, request: job.request, cache },
      [job.bytes.buffer, ...cache.map(([, content]) => content.buffer)]);
  }
}

// The cache files each source's parses wrote, least recently used first.
const kept = new Map();
// Sources the page's store had nothing for this visit.
const unstored = new Set();
let asked = 0;
const answers = new Map();

function askPage(sha256) {
  const id = ++asked;
  return new Promise((resolve) => {
    answers.set(id, resolve);
    self.postMessage({ type: "parse-cache", op: "get", id, sha256 });
  });
}
/** The page's reply to askPage. */
export function parseCacheAnswered({ id, files }) {
  answers.get(id)?.(files ?? null);
  answers.delete(id);
}

function keep(sha256, files) {
  const paths = kept.get(sha256) ?? new Set();
  kept.delete(sha256); kept.set(sha256, paths);
  for (const [path, content] of files) {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, content);
    paths.add(path);
  }
  const size = (path) => { try { return fs.statSync(path).size; } catch { return 0; } };
  let total = [...kept.values()].reduce((sum, set) => sum + [...set].reduce((bytes, path) => bytes + size(path), 0), 0);
  for (const [other, set] of kept) {
    if (total <= MEMORY_LIMIT || other === sha256) break;
    for (const path of set) { total -= size(path); fs.rmSync(path, { force: true }); }
    kept.delete(other);
  }
}

/** Makes the parse cache kept for this source readable by the runtime's engine. */
export async function seed(sha256) {
  if (!sha256) return;
  const paths = kept.get(sha256);
  if (paths && [...paths].every((path) => fs.existsSync(path))) {
    kept.delete(sha256); kept.set(sha256, paths); return;
  }
  if (unstored.has(sha256)) return;
  const files = await askPage(sha256);
  if (files?.length) keep(sha256, files); else unstored.add(sha256);
}

async function digest(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// What each parse of a source answered, by request, kept with its cache files: a request whose
// document is still cached is answered from here, without a parser.
const answersPath = (sha256) => `/parse-answers/${sha256}.json`;
function answered(sha256) {
  try { return JSON.parse(fs.readFileSync(answersPath(sha256), "utf8")); } catch { return {}; }
}
function known(sha256, request) {
  const summary = answered(sha256)[request];
  return summary && [...kept.get(sha256) ?? []].some((path) =>
    path.endsWith(`/${summary.cacheKey}.json.gz`) && fs.existsSync(path)) ? summary : undefined;
}

// Parses under way, by source and request: a second asker waits for the first's.
const parsing = new Map();

async function parse(sha256, bytes, request, requestKey, signal) {
  await seed(sha256);
  signal?.throwIfAborted();
  const cached = known(sha256, requestKey);
  if (cached) return cached;
  const { summary, files } = await run({ sha256, bytes: new Uint8Array(bytes), request, signal });
  keep(sha256, [...files, [answersPath(sha256),
    new TextEncoder().encode(JSON.stringify({ ...answered(sha256), [requestKey]: summary }))]]);
  unstored.delete(sha256);
  const stored = [...kept.get(sha256)].map((path) => [path, new Uint8Array(fs.readFileSync(path))]);
  self.postMessage({ type: "parse-cache", op: "put", sha256, files: stored },
    stored.map(([, content]) => content.buffer));
  return summary;
}

export const pdfParser = {
  start(module) { engine = module; },
  /** Readies a parser ahead of the first PDF; settles once it has the engine. */
  warm() {
    if (idle.length || running) return Promise.resolve();
    const worker = spawn();
    park(worker, true);
    return worker.started;
  },
  /** preparePdfDocument, in a parse Worker. */
  async prepare(bytes, request, signal) {
    const sha256 = request.expected_source_sha256 ?? await digest(bytes);
    const { id: _id, ...parsed } = request;
    const requestKey = await digest(new TextEncoder().encode(JSON.stringify(parsed)));
    if (kept.has(sha256)) {
      const cached = known(sha256, requestKey);
      if (cached) return cached;
    }
    const key = `${sha256}:${requestKey}`;
    let pending = parsing.get(key);
    if (!pending) {
      // Shared, so not cancelled by one asker: it settles once its parse does.
      pending = parse(sha256, bytes, request, requestKey).finally(() => parsing.delete(key));
      parsing.set(key, pending);
    }
    return signal ? Promise.race([pending, new Promise((_, reject) => {
      signal.throwIfAborted(); signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]) : pending;
  },
  seed,
};
