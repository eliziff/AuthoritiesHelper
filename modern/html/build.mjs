// Builds the self-contained Authorities.html: Beaver's Authorities workspace and
// runtime, the legal-structure engine compiled to WebAssembly, and the PDF.js fonts.
// Run from a Beaver checkout (this repository is its AuthoritiesHelper submodule) with
// cargo and the wasm32-wasip1 target installed; the engine is compiled here.
//
//   node AuthoritiesHelper/modern/html/build.mjs [output.html]
import { browserOcrAssets, browserOcrKey } from '../browser-ocr/package.mjs';
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { assertStandaloneFrontendModules } from "../scripts/authorities-package/bundle.mjs";
import { bundleRuntime } from "./runtime-bundle.mjs";
import { SIGNATURES } from "./structure-addon.mjs";

const here = import.meta.dirname, repo = path.resolve(here, "../../.."), frontend = path.join(repo, "frontend");
const engineCrate = path.join(repo, "native/legal-structure-node");
const fonts = path.join(frontend, "node_modules/pdfjs-dist/standard_fonts");
// One PDF.js for the page: the recognizer's renderer is built from the viewer's copy, and shares its worker and decoders.
const pdfjs = path.join(frontend, "node_modules/pdfjs-dist");

async function buildFrontend() {
  const require = createRequire(path.join(frontend, "package.json"));
  const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" },
    path.join(frontend, "vite.config.ts"), frontend);
  assert(loaded, "Authorities could not load the frontend build config");
  const outDir = mkdtempSync(path.join(tmpdir(), "authorities-html-"));
  try {
  const { codeSplitting: _groups, ...output } = loaded.config.build?.rolldownOptions?.output ?? {};
  const result = await build({ ...loaded.config, root: frontend, configFile: false, logLevel: "warn",
    plugins: [...(loaded.config.plugins ?? []), {name:'browser-pdf-text',enforce:'pre',
      resolveId(source) {
        if(source === './standalonePdfText') return path.join(here,'standalone-pdf-text.mjs');
        // The viewer's PDF.js worker comes from the page bridge, gzipped, not inlined as a data: URL.
        if(source === './pdfWorkerUrl') return path.join(here,'standalone-pdf-worker.mjs');
        if(source === './pdfDecoders') return path.join(here,'standalone-pdf-decoders.mjs');
      }}],
    build: { ...loaded.config.build, outDir, emptyOutDir: true, modulePreload: false,
      cssCodeSplit: false, assetsInlineLimit: () => true,
      rolldownOptions: { ...loaded.config.build?.rolldownOptions,
        input: { authorities: path.join(frontend, "authorities.html") },
        // One file cannot load chunks: every dynamic import is part of the page.
        output: { ...output, codeSplitting: false } } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(({ output }) => output);
  const modules = outputs.flatMap((item) => item.type === "chunk" ? Object.keys(item.modules) : []);
  assertStandaloneFrontendModules(modules);
  const chunks = outputs.filter((item) => item.type === "chunk");
  assert.equal(chunks.length, 1, `Authorities must build to one script, not ${chunks.length}`);
  const css = outputs.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => String(item.source)).join("\n");
  const html = readFileSync(path.join(outDir, "authorities.html"), "utf8");
  return { html, script: chunks[0].code, css };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

async function bundleScript(entry, define) {
  const { build } = createRequire(path.join(repo, "backend/package.json"))("esbuild");
  const result = await build({ entryPoints: [path.join(here, entry)], bundle: true, write: false,
    format: "iife", target: "es2022", minify: true, define, alias: { "pdfjs-dist": pdfjs } });
  return result.outputFiles[0].text;
}

const inline = (code) => code.replaceAll("</script", "<\\/script");

/** The engine as WebAssembly, with every source path rustc records (panic locations of the
 *  crate, its dependencies and std) mapped off this machine. Its own target directory keeps
 *  these flags from invalidating other builds of the crate. */
function buildEngine() {
  // Every operation the engine answers must be callable from the page, or the runtime fails at first use.
  const operations = [...readFileSync(path.join(engineCrate, "src/wasi.rs"), "utf8").matchAll(/^\s*"(\w+)" =>/gmu)]
    .map(([, name]) => name).filter((name) => name !== "releaseDocument" && !(name in SIGNATURES));
  assert.deepEqual(operations, [], `structure-addon.mjs lacks engine operations: ${operations.join(", ")}`);
  const home = homedir(), mappings = [[home, "/home"],
    [process.env.RUSTUP_HOME ?? path.join(home, ".rustup"), "/rustup"],
    [process.env.CARGO_HOME ?? path.join(home, ".cargo"), "/cargo"], [repo, "/beaver"]];
  const target = path.join(engineCrate, "target/authorities-html");
  execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-wasip1",
    "--manifest-path", path.join(engineCrate, "Cargo.toml"), "--target-dir", target], { stdio: "inherit",
    // Later mappings win; encoded flags keep paths with spaces whole and spare host build scripts.
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: mappings
      .map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join("\x1f") } });
  return readFileSync(path.join(target, "wasm32-wasip1/release/legal_structure_node.wasm"));
}

export async function buildAuthoritiesHtml(output) {
  const engine = buildEngine();
  const runtime = await bundleRuntime();
  const { html, script, css } = await buildFrontend();
  const ocr = { ...await browserOcrAssets() };
  const pdfWorker = readFileSync(path.join(pdfjs, "legacy/build/pdf.worker.min.mjs"));
  // Named for what is recognized (recognized text is kept by it), before the assets are packed: the
  // PDF.js that draws the pages is part of it.
  const ocrKey = browserOcrKey({ ...ocr, pdfWorker: pdfWorker.toString("base64") });
  // The worker that draws the pages to recognize: page code, like recognize-pdf.mjs, not in the key.
  ocr.rasterWorker = Buffer.from(await bundleScript("raster-worker.mjs")).toString("base64");
  // Gzip keeps the page small (these assets, the runtime and the fonts go in at a third of their
  // size): the page inflates the runtime as it starts and the recognizer's assets before the first
  // page is read, and the runtime Worker its engine, all off the main thread.
  const gzip = (bytes) => gzipSync(bytes, { level: 9 }).toString("base64");
  const packed = ["model", "ortMjs", "ortWasm", "recognitionWorker", "layoutCore", "layoutWasm", "rasterWorker"];
  for (const name of packed) ocr[name] = gzip(Buffer.from(ocr[name], "base64"));
  const payload = {
    runtime: gzip(Buffer.from(runtime.code)), ocr: { ...ocr, gzip: packed }, engine: gzip(engine),
    viewerPdfWorker: gzip(pdfWorker),
    pdfDecoders: Object.fromEntries(["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"]
      .map((name) => [name, gzip(readFileSync(path.join(pdfjs, "wasm", name)))])),
    fonts: Object.fromEntries(readdirSync(fonts).filter((name) => !name.startsWith("LICENSE"))
      .map((name) => [name, gzip(readFileSync(path.join(fonts, name)))])),
  };
  const bridge = await bundleScript("page-bridge.mjs",
    { __AUTHORITIES_PAYLOAD__: JSON.stringify(payload), __OCR_RUNTIME_SHA256__: JSON.stringify(ocrKey) });
  // Drop the build's external tags; the page carries everything inline.
  const page = html
    .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>\s*/gu, "")
    .replace(/<link\b[^>]*\brel="(?:stylesheet|modulepreload|icon)"[^>]*>\s*/gu, "")
    .replace("</head>", () => `<style>${css.replaceAll("</style", "<\\/style")}</style>\n` +
      `<script>${inline(bridge)}</script>\n</head>`)
    .replace("</body>", () => `<script type="module">${inline(script)}</script>\n</body>`);
  assert(!/\b(?:src|href)="\/(?:assets|src)\//u.test(page), "Authorities.html still references a build file");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, page);
  return { bytes: Buffer.byteLength(page), runtimeModules: runtime.inputs.length };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const target = process.argv.slice(2).find((value) => !value.startsWith("--"));
  const output = path.resolve(target ?? path.join(here, "../out/Authorities.html"));
  const { bytes } = await buildAuthoritiesHtml(output);
  console.log(`Built ${output} (${bytes} bytes)`);
}
