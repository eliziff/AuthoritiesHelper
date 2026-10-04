// Builds the self-contained "ALR Quote Verifier.html": Beaver's ALR verifier (backend/src/lib/alrVerifier)
// in the Authorities runtime Worker, with the legal-structure engine compiled to WebAssembly, and this
// folder's page. Everything is imported from the Beaver checkout at build time, so improving a Beaver
// primitive and running this build ships it. Compile the browser engine after Rust changes
// (npm run build:authorities-engine).
//
//   node AuthoritiesHelper/modern/alr/build.mjs [output.html] [--release]
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { bundleRuntime } from "../html/runtime-bundle.mjs";

const here = import.meta.dirname, modern = path.resolve(here, ".."), repo = path.resolve(modern, "../..");
const engineCrate = path.join(repo, "native/legal-structure-node");
const { build } = createRequire(path.join(modern, "package.json"))("esbuild");

// The runtime Worker serves createAuthoritiesOperations(): here, the verifier's.
const alrOperations = {
  name: "alr-operations",
  setup(builder) {
    builder.onResolve({ filter: /[\\/]authoritiesOperations$/ }, ({ importer }) =>
      /[\\/]html[\\/]runtime-worker\.mjs$/u.test(importer) ? { path: path.join(here, "runtime-operations.mjs") } : null);
  },
};

function engine(release) {
  // A dev page takes the engine built last; a release page only the optimized one, never older than the latest.
  const built = (profile) => path.join(engineCrate, `target/wasm32-wasip1/${profile}/legal_structure_node.wasm`);
  const stamp = (file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const file = release || stamp(built("release")) >= stamp(built("debug")) ? built("release") : built("debug");
  if (!existsSync(file)) throw new Error("Browser engine missing. Run npm run build:authorities-engine first.");
  if (release && stamp(built("debug")) > stamp(file))
    throw new Error("The optimized engine is older than the engine's latest build. Run node AuthoritiesHelper/modern/html/build-engine.mjs --release first.");
  return readFileSync(file);
}

const script = async (entry, options = {}) => (await build({ entryPoints: [entry], bundle: true, write: false,
  format: "iife", target: "es2022", minify: true, legalComments: "none", ...options })).outputFiles[0].text;
const inline = (code) => code.replaceAll("</script", "<\\/script");

export async function buildAlrHtml(output, { release = false, plugins = [] } = {}) {
  const pack = (bytes) => gzipSync(bytes, { level: release ? 9 : 1 }).toString("base64");
  const [runtime, bridge, app] = await Promise.all([
    bundleRuntime({ plugins: [...plugins, alrOperations] }),
    // The page bridge starts the runtime Worker and answers its requests. The page has no PDF viewer
    // and no text recognizer: sources and articles are born-digital PDFs and Word files.
    script(path.join(modern, "html/page-bridge.mjs"), { define: { __OCR_RUNTIME_SHA256__: '""' } }),
    script(path.join(here, "app.jsx"), { plugins, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
      alias: { react: path.join(modern, "node_modules/react"), "react-dom": path.join(modern, "node_modules/react-dom") } }),
  ]);
  const payload = { runtime: pack(Buffer.from(runtime.code)), engine: pack(engine(release)), ocr: { gzip: [] },
    viewerPdfWorker: "", pdfDecoders: {}, fonts: {} };
  const [head, ...tail] = bridge.split("__AUTHORITIES_PAYLOAD__");
  if (tail.length !== 1) throw new Error("The page bridge must read its payload once");
  const css = readFileSync(path.join(here, "styles.css"), "utf8").replaceAll("</style", "<\\/style");
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ALR Quote Verifier</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(ICON)}">
<style>${css}</style>
<script>${inline(head + JSON.stringify(payload) + tail[0])}</script>
</head>
<body>
<div id="root"></div>
<script type="module">${inline(app)}</script>
</body>
</html>
`;
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, page);
  return { bytes: Buffer.byteLength(page), runtimeModules: runtime.inputs.length };
}

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0f3a28"/><path d="M9 23 16 8l7 15M11.6 18h8.8" fill="none" stroke="#f4efe1" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const target = process.argv.slice(2).find((value) => !value.startsWith("--"));
  const output = path.resolve(target ?? path.join(modern, "out/ALR Quote Verifier.html"));
  const started = Date.now();
  const { bytes, runtimeModules } = await buildAlrHtml(output, { release: process.argv.includes("--release") });
  console.log(`Built ${output} (${bytes} bytes, ${runtimeModules} runtime modules, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
  // --all: every ALR output from this checkout: the viewer, then the private program from this page.
  if (process.argv.includes("--all")) {
    const { buildViewer } = await import("./viewer/build.mjs");
    console.log("Built the viewer:", await buildViewer({ outDir: path.dirname(output) }));
    const { buildAlrExe, checkPublicHtml } = await import("./exe/build.mjs");
    console.log("Public page check:", checkPublicHtml(output));
    const { exe, bytes: exeBytes } = await buildAlrExe({ publicHtml: output, outDir: path.dirname(output) });
    console.log(`Built ${exe} (${(exeBytes / 1e9).toFixed(2)} GB)`);
  }
}
