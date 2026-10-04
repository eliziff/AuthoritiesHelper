// The private edition's program: serves the ALR UI on a loopback port and runs the verifier's
// operations natively (Beaver's backend code and its native legal-structure engine), with the
// journal database that only this edition carries. Bundled into one Node single executable by
// build.mjs; the databases and engine are appended to it and unpacked once (overlay.mjs).
import "./quiet.mjs";
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sea from "node:sea";
import { readOverlay, unpackOverlay } from "./overlay.mjs";
import { decodeWire, encodeWire } from "./wire.mjs";

const APP = "alr-quote-verifier";
const PORT = Number(process.env.ALR_PORT || 32150);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const appHome = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE ?? ".", "AppData", "Local"),
  "ALR Quote Verifier");

const openBrowser = (url) => process.env.ALR_NO_BROWSER ? undefined :
  execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], () => {});

/** A copy of this program already serving this port: show it and leave. */
async function running() {
  try {
    const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) });
    return (await response.json())?.app === APP;
  } catch { return false; }
}

/** Unpacks the appended data once, then points Beaver's providers at it. */
function unpackData() {
  const footer = readOverlay(process.execPath);
  if (!footer) throw new Error("This program file carries no data. Use the complete ALR Quote Verifier.exe.");
  const started = performance.now();
  let shown = "";
  const paths = unpackOverlay(process.execPath, footer, path.join(appHome, "data"), (name, done, total) => {
    const line = `Preparing ${name} for first use: ${Math.floor(done / total * 100)}%`;
    if (line !== shown) process.stdout.write(`\r${shown = line}`);
  });
  if (shown) process.stdout.write(`\nPrepared in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
  process.env.LEGAL_STRUCTURE_NATIVE = paths["legal_structure_node.dll"];
  process.env.MIKE_PUBLIC_ENDPOINT_DB = paths["public_endpoint.db"];
  const search = paths["public_endpoint-search.sqlite"];
  if (search) {
    process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = search;
    relocateSearchIndex(search, paths["public_endpoint.db"]);
  }
}

/** The search index names its journal database by path and modification time. The build checked that it
 *  indexes exactly the appended database; after unpacking, it names that database's new location. */
function relocateSearchIndex(index, source) {
  const stat = statSync(source), want = { source_path: path.resolve(source),
    source_mtime_ms: String(Math.trunc(stat.mtimeMs)) };
  const db = new DatabaseSync(index);
  try {
    const meta = Object.fromEntries(db.prepare("SELECT key, value FROM meta").all().map((row) => [row.key, row.value]));
    if (meta.source_size !== String(stat.size)) throw new Error("The journal search index does not match its database");
    const update = db.prepare("UPDATE meta SET value = ? WHERE key = ?");
    for (const [key, value] of Object.entries(want)) if (meta[key] !== value) update.run(value, key);
  } finally { db.close(); }
}

/** The A2AJ corpus is read from, and downloaded into, this computer's shared corpus folder
 *  (MIKE_A2AJ_PARQUET_DIR, else OpenLegalData's providers/a2aj/parquet), not a folder the page picks. */
function withCorpus(input) {
  if (input && typeof input === "object" && typeof input.corpus !== "string") delete input.corpus;
  return input;
}

const writers = new Map();
let nextWriter = 0;
/** The page's corpus panel works on this folder (page-client.mjs): its files, at relative paths inside it. */
async function corpusFolderRequest(folder, request, url) {
  const relative = (value) => {
    const text = String(value ?? "");
    if (!text || text.startsWith("/") || text.includes("\\") || text.includes(":") ||
      text.split("/").some((part) => !part || part === "." || part === "..")) throw Object.assign(new Error("Invalid corpus path"), { status: 400 });
    return text;
  };
  const write = url.pathname.match(/^\/api\/corpus-folder\/write\/(\d+)$/u)?.[1];
  if (write) {
    const writer = writers.get(Number(write)) ?? Promise.reject(Object.assign(new Error("No such download"), { status: 404 }));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    await (await writer).write(new Uint8Array(Buffer.concat(chunks)));
    return null;
  }
  const { op, path: file, to, start, end, at, text, id } = decodeWire(await body(request));
  switch (op) {
    case "readText": return folder.readText(relative(file));
    case "writeText": return folder.writeText(relative(file), String(text));
    case "size": return folder.size(relative(file));
    case "read": return folder.read(relative(file), Number(start), Number(end));
    case "rename": return folder.rename(relative(file), relative(to));
    case "remove": return folder.remove(relative(file));
    case "append": { const key = ++nextWriter; writers.set(key, folder.append(relative(file), Number(at))); await writers.get(key); return key; }
    case "close": { const writer = writers.get(Number(id)); writers.delete(Number(id)); await (await writer)?.close(); return null; }
    default: throw Object.assign(new Error("Unknown corpus folder request"), { status: 400 });
  }
}

function refuse(response, status, detail) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ detail }));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function start() {
  if (await running()) { openBrowser(`${ORIGIN}/`); return; }
  unpackData();
  const page = Buffer.from(sea.getAsset("ui.html"));
  // The operations the self-contained page runs in its Worker, run here natively.
  const { createAuthoritiesOperations } = await import("../runtime-operations.mjs");
  const operations = createAuthoritiesOperations();
  const { nodeA2AJFolder, a2ajParquetDirectory } = await import("../../../../backend/src/lib/a2ajCorpusNode.ts");
  const corpusFolder = nodeA2AJFolder(a2ajParquetDirectory());
  const server = createServer(async (request, response) => {
    // Loopback only, and only from this program's own page.
    if (request.headers.host !== `127.0.0.1:${PORT}` || request.headers.origin && request.headers.origin !== ORIGIN)
      return refuse(response, 403, "This local request was refused");
    const url = new URL(request.url, ORIGIN);
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return response.end(JSON.stringify({ status: "ok", app: APP }));
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return response.end(page);
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/corpus-folder")) {
      try {
        const result = await corpusFolderRequest(corpusFolder, request, url);
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(encodeWire({ result }));
      } catch (error) {
        if (!Number.isInteger(error?.status)) console.error(error);
        return refuse(response, Number.isInteger(error?.status) ? error.status : 500, String(error?.message ?? error));
      }
    }
    const operation = request.method === "POST" && url.pathname.match(/^\/api\/operations\/([a-zA-Z]+)$/u)?.[1];
    if (!operation || typeof operations[operation] !== "function") return refuse(response, 404, "Not found");
    // One line of JSON per progress report, then the result: the page reads them as they come.
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableFinished) controller.abort(); });
    let input;
    try { input = withCorpus(decodeWire(await body(request))); }
    catch { return refuse(response, 400, "The request was not valid JSON"); }
    response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    const send = (message) => response.write(`${encodeWire(message)}\n`);
    try {
      const result = await operations[operation](input, { signal: controller.signal,
        progress: (value) => send({ type: "progress", value }),
        quoteProgress: (value) => send({ type: "quote-progress", value }) });
      send({ type: "result", result });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status === 500 && !controller.signal.aborted) console.error(error);
      send({ type: "error", status, message: status === 500
        ? "ALR Quote Verifier could not complete that operation" : String(error?.message ?? error) });
    }
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(error.code === "EADDRINUSE"
      ? new Error(`Another program is using port ${PORT}. Close it, or set ALR_PORT to another port.`) : error));
    server.listen(PORT, "127.0.0.1", resolve);
  });
  console.log(`ALR Quote Verifier is running at ${ORIGIN}/\nClose this window to stop it.`);
  openBrowser(`${ORIGIN}/`);
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

start().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  // The console window would vanish with the message: keep it until a key is pressed.
  if (process.stdin.isTTY && !process.env.ALR_NO_BROWSER) {
    console.error("Press any key to close.");
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.once("data", () => process.exit());
  }
});
