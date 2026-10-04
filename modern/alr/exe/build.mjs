// Builds the private edition, "ALR Quote Verifier (Private).exe": one Node single executable
// (https://nodejs.org/docs/latest-v22.x/api/single-executable-applications.html) that serves the
// same page as the public .html from a loopback port and runs the verifier natively, with the full
// journal database, its search index and the native legal-structure engine appended (overlay.mjs).
// Called by the ALR build (alr/build.mjs); checkPublicHtml() guards the public page.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync,
  writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { localOnly, sharedContractSource, writeThirdPartyNotices } from "../../scripts/authorities-package/bundle.mjs";
import { appendOverlay } from "./overlay.mjs";

const here = import.meta.dirname, modern = path.resolve(here, "../.."), repo = path.resolve(modern, "../..");
const backend = path.join(repo, "backend");
const cache = path.join(modern, "out/.cache");
export const EXE_NAME = "ALR Quote Verifier (Private).exe";
// The Node release every packaged Beaver app runs on (package-authorities.ps1).
const NODE = { version: "22.20.0", sha256: "bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d" };
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const PUBLIC_DATASET = "ALTA-L-REV";

const openLegalData = () => path.resolve(process.env.OPEN_LEGAL_DATA_HOME?.trim() ||
  path.join(process.env.LOCALAPPDATA ?? "", "OpenLegalData"));

function meta(filename, table) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return Object.fromEntries(db.prepare(`SELECT key, value FROM ${table}`).all().map((row) => [row.key, row.value])); }
  finally { db.close(); }
}

/** The journal database Beaver's journal source reads, and its search index (legalSources/journal.ts). */
export function journalData() {
  const journals = path.join(openLegalData(), "providers/journals");
  const index = path.resolve(process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB?.trim() ||
    path.join(journals, "public_endpoint-search.sqlite"));
  const shared = path.join(journals, "public_endpoint.db");
  const database = path.resolve(process.env.MIKE_PUBLIC_ENDPOINT_DB?.trim() ||
    (existsSync(shared) ? shared : existsSync(index) ? meta(index, "meta").source_path ?? shared : shared));
  if (!existsSync(database)) throw new Error(`The journal database is missing: ${database}`);
  if (!existsSync(index)) throw new Error(`The journal search index is missing: ${index}. ` +
    "Build it with python backend/scripts/build_journal_search_index.py");
  const indexed = meta(index, "meta"), source = meta(database, "export_metadata"), stat = statSync(database);
  const current = path.resolve(indexed.source_path ?? "").toLowerCase() === database.toLowerCase() &&
    indexed.source_size === String(stat.size) && indexed.source_mtime_ms === String(Math.trunc(stat.mtimeMs)) &&
    indexed.source_created_at === source.created_at && indexed.source_schema_version === source.schema_version;
  if (!current) throw new Error(`The journal search index ${index} does not index ${database}. ` +
    "Rebuild it with python backend/scripts/build_journal_search_index.py");
  return { database, index };
}

async function nodeExecutable() {
  const name = `node-v${NODE.version}-win-x64`, archive = path.join(cache, `${name}.zip`);
  const executable = path.join(cache, name, "node.exe");
  mkdirSync(cache, { recursive: true });
  if (!existsSync(archive)) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE.version}/${name}.zip`);
    if (!response.ok) throw new Error(`Node download failed (${response.status})`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== NODE.sha256) throw new Error(`Node archive hash mismatch: ${archive}`);
  if (!existsSync(executable))
    // Windows' own tar (bsdtar) reads zip archives; another tar on the PATH may not.
    execFileSync(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/tar.exe"), ["-xf", path.basename(archive), `${name}/node.exe`, `${name}/LICENSE`], { cwd: cache });
  return { executable, license: path.join(cache, name, "LICENSE") };
}

async function bundleProgram(file, plugins) {
  const { build } = createRequire(path.join(backend, "package.json"))("esbuild");
  // The native program has the public page's PDF profile: born-digital PDFs, no text recognition.
  const pdfProfile = { name: "alr-pdf-profile", setup(builder) {
    builder.onResolve({ filter: /[\\/]pdfProfile$/ }, () => ({ path: path.join(modern, "html/pdf-profile.mjs") }));
  } };
  const result = await build({ absWorkingDir: backend, entryPoints: [path.join(here, "server.mjs")], outfile: file,
    bundle: true, platform: "node", format: "cjs", target: "node22", metafile: true, logLevel: "warning",
    minifySyntax: true, minifyWhitespace: true, legalComments: "none",
    plugins: [...plugins, sharedContractSource, localOnly, pdfProfile] });
  const inputs = Object.keys(result.metafile.inputs);
  for (const input of inputs) assert.doesNotMatch(input.replaceAll("\\", "/"),
    /(?:\/src\/(?:middleware\/auth|index|runtime|supervisor)\.ts|\/src\/lib\/(?:jobQueue|relationalDatabase|supabase)\.ts|\/node_modules\/(?:@supabase|openai|@anthropic-ai)\/)/u,
    `The private edition includes a Beaver deployment dependency: ${input}`);
  return inputs;
}

/** The public page with its Worker runtime replaced by the client of this program's operations. */
async function programPage(publicHtml) {
  const { build } = createRequire(path.join(modern, "package.json"))("esbuild");
  const client = (await build({ entryPoints: [path.join(here, "page-client.mjs")], bundle: true, write: false,
    format: "iife", target: "es2022", minify: true, legalComments: "none" })).outputFiles[0].text;
  const html = readFileSync(publicHtml, "utf8");
  // The page bridge is the head's only classic script (alr/build.mjs).
  const bridges = [...html.matchAll(/<script>[\s\S]*?<\/script>/gu)].filter((match) => match.index < html.indexOf("</head>"));
  assert.equal(bridges.length, 1, "The ALR page must have one page bridge script in its head");
  assert.match(bridges[0][0], /AUTHORITIES_OPERATIONS/u, "The ALR page's head script is not its page bridge");
  return html.slice(0, bridges[0].index) + `<script>${client.replaceAll("</script", "<\\/script")}</script>` +
    html.slice(bridges[0].index + bridges[0][0].length);
}

/** Builds the private executable from the public page at `publicHtml`; returns its path and size. */
export async function buildAlrExe({ publicHtml, outDir = path.join(modern, "out"), plugins = [] } = {}) {
  const started = Date.now();
  const engine = path.join(repo, "native/legal-structure-node/target/release/legal_structure_node.dll");
  if (!existsSync(engine)) throw new Error(`The native engine is missing: ${engine}. Run npm run native:build -- --release.`);
  const { database, index } = journalData();
  const stage = mkdtempSync(path.join(tmpdir(), "alr-exe-"));
  try {
    const inputs = await bundleProgram(path.join(stage, "server.cjs"), plugins);
    writeFileSync(path.join(stage, "ui.html"), await programPage(publicHtml));
    const node = await nodeExecutable();
    writeThirdPartyNotices(stage, inputs, backend, "npm");
    writeFileSync(path.join(stage, "notices.txt"), [readFileSync(path.join(stage, "licenses/npm-licenses.txt"), "utf8"),
      `===== Node.js ${NODE.version}: LICENSE =====\n${readFileSync(node.license, "utf8")}`].join("\n\n"));
    writeFileSync(path.join(stage, "sea-config.json"), JSON.stringify({ main: path.join(stage, "server.cjs"),
      output: path.join(stage, "sea.blob"), disableExperimentalSEAWarning: true, useCodeCache: true,
      assets: { "ui.html": path.join(stage, "ui.html"), "notices.txt": path.join(stage, "notices.txt") } }));
    // The blob must come from the Node that runs it.
    execFileSync(node.executable, ["--experimental-sea-config", path.join(stage, "sea-config.json")], { stdio: "inherit" });
    mkdirSync(outDir, { recursive: true });
    const exe = path.join(outDir, EXE_NAME), building = `${exe}.partial`;
    rmSync(building, { force: true });
    copyFileSync(node.executable, building);
    const { inject } = createRequire(path.join(modern, "package.json"))("postject");
    await inject(building, "NODE_SEA_BLOB", readFileSync(path.join(stage, "sea.blob")), { sentinelFuse: SEA_FUSE });
    await appendOverlay(building, [{ name: "legal_structure_node.dll", file: engine },
      { name: "public_endpoint.db", file: database }, { name: "public_endpoint-search.sqlite", file: index }]);
    // Renamed whole: a failed build never leaves a program that lacks its data.
    rmSync(exe, { force: true }); renameSync(building, exe);
    return { exe, bytes: statSync(exe).size, seconds: (Date.now() - started) / 1000 };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

// ---- The public page must carry no private data -------------------------------------------------
// Port of the idea of ALR-Quote-Verifier packaging/build_exe.py _bytecode_gate: the public build fails
// when anything only the private edition may carry is found in it, including inside its packed payloads.

const WINDOW = 48;
/** Every text in the page: the page itself and each base64 payload, inflated when packed. */
function base64Runs(text) {
  const runs = [];
  for (let at = 0, start = -1; at <= text.length; at += 1) {
    const code = at < text.length ? text.charCodeAt(at) : 0;
    const base64 = code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 47 && code <= 57 || code === 43;
    if (base64) { if (start < 0) start = at; continue; }
    if (start >= 0 && at - start >= 512) runs.push(text.slice(start, at));
    start = -1;
  }
  return runs;
}

function pageTexts(html) {
  const texts = [html];
  for (let next = 0, depth = [0]; next < texts.length; next += 1) {
    if (depth[next] >= 2) continue;
    for (const blob of base64Runs(texts[next])) {
      const bytes = Buffer.from(blob, "base64");
      for (const unpack of [gunzipSync, inflateSync, brotliDecompressSync, (value) => value]) {
        try { texts.push(unpack(bytes).toString("latin1")); depth.push(depth[next] + 1); break; }
        catch { /* not this packing */ }
      }
    }
  }
  return texts;
}

/** Distinctive ASCII passages of each journal article outside the public subset: its title and three of
 *  its sentences. Map of passage to article. */
function privateJournalPassages(database) {
  const db = new DatabaseSync(database, { readOnly: true }), passages = new Map();
  const window = new RegExp(`[A-Za-z][A-Za-z0-9 ,.;:()-]{${WINDOW - 1}}`, "u");
  try {
    const rows = db.prepare(`SELECT article_id, name_en, substr(text, 2000, 2000) AS a, substr(text, 8000, 2000) AS b,
      substr(text, 20000, 2000) AS c FROM articles WHERE dataset <> ? AND text IS NOT NULL`).all(PUBLIC_DATASET);
    for (const row of rows) for (const source of [row.name_en, row.a, row.b, row.c]) {
      const match = String(source ?? "").match(window)?.[0];
      // A passage of only a few common words could appear anywhere.
      if (match && new Set(match.toLowerCase().match(/[a-z]{4,}/gu)).size >= 5) passages.set(match, row.article_id);
    }
    // Wording the public subset also has (a statute's name, a stock phrase) is no evidence of a leak.
    for (const passage of findWindows(db.prepare("SELECT name_en || ' ' || COALESCE(text, '') AS text FROM articles WHERE dataset = ?")
      .all(PUBLIC_DATASET).map((row) => row.text), [...passages.keys()])) passages.delete(passage);
    return passages;
  } finally { db.close(); }
}

/** Rabin-Karp over fixed-length windows (hashes mod 2^32): every needle at once, one pass over each text. */
function findWindows(texts, needles) {
  const BASE = 257;
  let power = 1;
  for (let index = 1; index < WINDOW; index += 1) power = Math.imul(power, BASE);
  const hash = (text, from) => { let value = 0; for (let index = 0; index < WINDOW; index += 1)
    value = Math.imul(value, BASE) + text.charCodeAt(from + index) | 0; return value; };
  const wanted = new Map();
  for (const needle of needles) wanted.set(hash(needle, 0), [...wanted.get(hash(needle, 0)) ?? [], needle]);
  const hits = new Set();
  for (const text of texts) {
    if (text.length < WINDOW) continue;
    let value = hash(text, 0);
    for (let at = 0; ; at += 1) {
      const candidates = wanted.get(value);
      if (candidates) for (const needle of candidates) if (text.startsWith(needle, at)) hits.add(needle);
      if (at + WINDOW >= text.length) break;
      value = Math.imul(value - Math.imul(text.charCodeAt(at), power), BASE) + text.charCodeAt(at + WINDOW) | 0;
    }
  }
  return [...hits];
}

const KEY_PATTERNS = [/\bsk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{32,}/u, /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bgsk_[A-Za-z0-9]{40,}/u, /\bcsk-[a-z0-9]{40,}/u];

/** Fails when the public page carries private journal content, the private program's own names or keys. */
export function checkPublicHtml(publicHtml) {
  const texts = pageTexts(readFileSync(publicHtml, "utf8"));
  const problems = [];
  // Literals only the private program carries (overlay.mjs, server.mjs, this file).
  for (const name of ["ALRVOVL1", EXE_NAME, "This program file carries no data",
    "The journal search index does not match its database"]) {
    if (texts.some((text) => text.includes(name))) problems.push(`private program name ${JSON.stringify(name)}`);
  }
  for (const pattern of KEY_PATTERNS) {
    const hit = texts.map((text) => text.match(pattern)?.[0]).find(Boolean);
    if (hit) problems.push(`an API key (${hit.slice(0, 8)}…)`);
  }
  const passages = privateJournalPassages(journalData().database), articles = new Map();
  for (const passage of findWindows(texts, [...passages.keys()]))
    articles.set(passages.get(passage), [...articles.get(passages.get(passage)) ?? [], passage]);
  // One phrase in common with one article is chance; two passages of the same article are its text.
  const leaked = [...articles.values()].filter((found) => found.length >= 2);
  if (leaked.length) problems.push(`the text of ${leaked.length} journal articles outside ${PUBLIC_DATASET}, ` +
    `e.g. ${JSON.stringify(leaked[0][0])}`);
  if (problems.length) throw new Error(`The public page carries private data: ${problems.join("; ")}`);
  return { texts: texts.length, bytes: texts.reduce((total, text) => total + text.length, 0), passages: passages.size,
    singlePassageMatches: articles.size };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const publicHtml = path.resolve(process.argv[2] ?? path.join(modern, "out/ALR Quote Verifier.html"));
  console.log("Public page check:", checkPublicHtml(publicHtml));
  const { exe, bytes, seconds } = await buildAlrExe({ publicHtml });
  console.log(`Built ${exe} (${(bytes / 1e9).toFixed(2)} GB, ${seconds.toFixed(1)} s)`);
}
