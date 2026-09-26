// Builds the self-contained Authorities.html: Beaver's Authorities workspace and
// runtime, the legal-structure engine compiled to WebAssembly, and the PDF.js fonts.
// Run from a Beaver checkout (this repository is its AuthoritiesHelper submodule)
// after `cargo build --locked --release --target wasm32-wasip1` in native/legal-structure-node.
//
//   node AuthoritiesHelper/modern/html/build.mjs [output.html]
//   node AuthoritiesHelper/modern/html/build.mjs --relay [relay-worker.js]
// AUTHORITIES_RELAY_URL names the deployed relay the page uses for publisher sources.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertStandaloneFrontendModules } from "../scripts/authorities-package/bundle.mjs";
import { bundleRuntime } from "./runtime-bundle.mjs";

const here = import.meta.dirname, repo = path.resolve(here, "../../.."), frontend = path.join(repo, "frontend");
const engine = path.join(repo, "native/legal-structure-node/target/wasm32-wasip1/release/legal_structure_node.wasm");
const fonts = path.join(frontend, "node_modules/pdfjs-dist/standard_fonts");
// The publisher relay (relay-worker.mjs) as deployed; empty leaves remote sources unavailable.
const relayUrl = process.env.AUTHORITIES_RELAY_URL ?? "";

async function buildFrontend() {
  const require = createRequire(path.join(frontend, "package.json"));
  const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" },
    path.join(frontend, "vite.config.ts"), frontend);
  assert(loaded, "Authorities could not load the frontend build config");
  const outDir = mkdtempSync(path.join(tmpdir(), "authorities-html-"));
  const { codeSplitting: _groups, ...output } = loaded.config.build?.rolldownOptions?.output ?? {};
  const result = await build({ ...loaded.config, root: frontend, configFile: false, logLevel: "warn",
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
  rmSync(outDir, { recursive: true, force: true });
  return { html, script: chunks[0].code, css };
}

async function bundleBridge(payload) {
  const { build } = createRequire(path.join(repo, "backend/package.json"))("esbuild");
  const result = await build({ entryPoints: [path.join(here, "page-bridge.mjs")], bundle: true, write: false,
    format: "iife", target: "es2022", minify: true, define: { __AUTHORITIES_PAYLOAD__: JSON.stringify(payload) } });
  return result.outputFiles[0].text;
}

const inline = (code) => code.replaceAll("</script", "<\\/script");

export async function buildAuthoritiesHtml(output) {
  const runtime = await bundleRuntime();
  const { html, script, css } = await buildFrontend();
  const bridge = await bundleBridge({
    runtime: runtime.code, relayUrl,
    engine: readFileSync(engine).toString("base64"),
    fonts: Object.fromEntries(readdirSync(fonts).filter((name) => !name.startsWith("LICENSE"))
      .map((name) => [name, readFileSync(path.join(fonts, name)).toString("base64")])),
  });
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

/** The relay Worker (relay-worker.mjs) as one module for Cloudflare. */
export async function buildRelay(output) {
  const { build } = createRequire(path.join(repo, "backend/package.json"))("esbuild");
  await build({ entryPoints: [path.join(here, "relay-worker.mjs")], bundle: true, outfile: output,
    format: "esm", platform: "neutral", target: "es2022", minify: true, legalComments: "none" });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2), relay = args.includes("--relay");
  const target = args.find((value) => !value.startsWith("--"));
  if (relay) {
    const output = path.resolve(target ?? path.join(here, "../out/relay-worker.js"));
    await buildRelay(output); console.log(`Built ${output}`);
  } else {
    const output = path.resolve(target ?? path.join(here, "../out/Authorities.html"));
    const { bytes } = await buildAuthoritiesHtml(output);
    console.log(`Built ${output} (${bytes} bytes)`);
  }
}
