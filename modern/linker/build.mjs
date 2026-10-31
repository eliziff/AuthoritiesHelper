// Builds "Authority Linker.html": Authorities.html's build (html/build.mjs) with this folder's page as its entry and its
// one operation (operations.ts) as the runtime's, offline. Run from the combined checkout after the browser engine
// (html/build-engine.mjs --word: the page reads no PDFs, so its engine is the Word-only one):
//   node AuthoritiesHelper/modern/linker/build.mjs [output.html] [--release]
import path from "node:path";
import { buildAuthoritiesHtml } from "../html/build.mjs";

const here = import.meta.dirname;
const args = process.argv.slice(2), release = args.includes("--release");
const output = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? path.join(here, "../out/Authority Linker.html"));
// The runtime worker imports Authorities' operations; this page's runtime has its own.
const operations = { name: "authority-linker-operations", setup(build) {
  build.onResolve({ filter: /authoritiesOperations$/ }, ({ importer }) =>
    /[\\/]html[\\/]runtime-worker\.mjs$/u.test(importer) ? { path: path.join(here, "operations.ts") } : null);
} };
const result = await buildAuthoritiesHtml(output, { release, app: { name: "authority-linker", store: "authority-linker",
  title: "Authority Linker", description: "Add citation and pinpoint hyperlinks to a copy of a Word document.",
  entry: path.join(here, "main.tsx"), runtimePlugins: [operations], network: false, connectSources: [], localStores: false,
  ukCaseLaw: false, pdfs: false } });
console.log(`Built ${output} (${result.bytes} bytes)`);
