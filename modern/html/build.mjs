// Builds the self-contained Authorities.html: Beaver's Authorities workspace and
// runtime, the legal-structure engine compiled to WebAssembly, and the PDF.js fonts.
// Run from the combined checkout. Compile the browser engine explicitly after Rust changes.
//
//   node AuthoritiesHelper/modern/html/build.mjs [output.html] [--release]
import { browserOcrAssets, browserOcrKey } from '../browser-ocr/package.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { bundleRuntime } from "./runtime-bundle.mjs";
import { cached, inputStamp } from "./build-cache.mjs";

const here = import.meta.dirname, repo = path.resolve(here, "../../.."), frontend = path.join(repo, "frontend");
const backend = path.join(repo, "backend");
const engineCrate = path.join(repo, "native/legal-structure-node");
const frontendRequire = createRequire(path.join(frontend, "package.json"));
const pdfjs = path.dirname(frontendRequire.resolve("pdfjs-dist/package.json"));
const fonts = path.join(pdfjs, "standard_fonts");
const cacheDir = path.join(here, "../out/.build-cache");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// The files a bundler reported reading, without its virtual modules or query suffixes.
const bundledFiles = (ids, base) => ids.map((id) => id.replace(/[?#].*$/u, ""))
  .filter((id) => !id.startsWith("\0") && !/^[\w-]{2,}:/u.test(id)).map((id) => path.resolve(base, id))
  .filter((file) => statSync(file, { throwIfNoEntry: false })?.isFile());
const packageManifests = files => [...new Set(files.flatMap(file => {
  const parts = file.replaceAll('\\', '/').split('/'), index = parts.lastIndexOf('node_modules');
  return index < 0 ? [] : [path.join(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join('/'), 'package.json')];
}))];

async function buildFrontend(release, entry) {
  const require = createRequire(path.join(frontend, "package.json"));
  const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve("vite")).href);
  const configFile = path.join(frontend, 'vite.config.ts');
  const observed = { [configFile]: inputStamp(configFile) };
  const loaded = await loadConfigFromFile({ command: "build", mode: release ? "authorities" : "authorities-dev" },
    path.join(frontend, "vite.config.ts"), frontend);
  assert(loaded, "Authorities could not load the frontend build config");
  const mode = release ? 'authorities' : 'authorities-dev';
  const envFiles = loaded.config.envDir === false ? [] : ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
    .map(name => path.resolve(frontend, loaded.config.envDir ?? '.', name));
  Object.assign(observed, Object.fromEntries([...loaded.dependencies, ...envFiles].map(file => [file, inputStamp(file)])));
  let watch = [], config;
  const outDir = mkdtempSync(path.join(tmpdir(), "authorities-html-"));
  try {
  const { codeSplitting: _groups, ...output } = loaded.config.build?.rolldownOptions?.output ?? {};
  const result = await build({ ...loaded.config, root: frontend, configFile: false, logLevel: "warn",
    plugins: [...(loaded.config.plugins ?? []), {
      name: 'authorities-build-inputs',
      configResolved(resolved) { config = resolved; },
      generateBundle() { watch = this.getWatchFiles?.() ?? []; },
    }, {name:'browser-pdf-text',enforce:'pre',
      resolveId(source, importer) {
        // Another app built on this page (ALR) starts from its own entry, which may live outside this
        // checkout: its packages are the frontend's.
        if (entry && /[\\/]authoritiesMain\.tsx$/u.test(source)) return entry;
        if (entry && importer && /^[@\w]/u.test(source) && !source.startsWith('@/') &&
            !path.resolve(importer).startsWith(repo)) return this.resolve(source, path.join(frontend, 'src/authoritiesMain.tsx'), { skipSelf: true });
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
  const chunks = outputs.filter((item) => item.type === "chunk");
  assert.equal(chunks.length, 1, `Authorities must build to one script, not ${chunks.length}`);
  const css = outputs.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => String(item.source)).join("\n");
  const html = readFileSync(path.join(outDir, "authorities.html"), "utf8");
  const resolvedEnvFiles = config.envDir === false ? [] : ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
    .map(name => path.join(config.envDir, name));
  const files = bundledFiles([...Object.keys(chunks[0].modules), ...watch.filter(input => !/[*?{[]/u.test(input))], frontend);
  // These are the actual compiler/plugin imports in vite.config.ts, including its delivery-only compiler.
  const compilers = ['vite', 'rolldown', '@vitejs/plugin-react', '@tailwindcss/vite', '@tailwindcss/node', '@tailwindcss/oxide',
    ...release ? ['@rolldown/plugin-babel', '@babel/core', 'babel-plugin-react-compiler'] : []].map(name => require.resolve(name));
  return { value: { html, script: chunks[0].code, css }, watch: [...watch, ...loaded.dependencies], observed,
    inputs: [...loaded.dependencies, ...envFiles, ...resolvedEnvFiles, ...files, ...packageManifests([...files, ...compilers]),
      path.join(here, 'build-cache.mjs'), path.join(frontend, 'package.json'), path.join(repo, 'shared/package.json')] };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

// One PDF.js for the page: the recognizer's renderer is built from the viewer's copy, and shares its worker and decoders.
async function bundleScript(entry, define) {
  const { build } = createRequire(path.join(repo, "backend/package.json"))("esbuild");
  const result = await build({ entryPoints: [path.join(here, entry)], bundle: true, write: false,
    format: "iife", target: "es2022", minify: true, define, alias: { "pdfjs-dist": pdfjs } });
  return result.outputFiles[0].text;
}

const inline = (code) => code.replaceAll("</script", "<\\/script");

/** `app`: another app made of this page (ALR): its `name`, its page `title`, the `entry` that starts it in
 *  place of authoritiesMain.tsx, and esbuild `runtimePlugins` that give its runtime its operations. */
export async function buildAuthoritiesHtml(output, { release = false, app } = {}) {
  // A dev page takes the engine built last, fast to compile; a release page only the optimized one,
  // and never one older than the engine's latest changes.
  const built = (profile) => path.join(engineCrate, `target/wasm32-wasip1/${profile}/legal_structure_node.wasm`);
  const stamp = (file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const artifact = release || stamp(built("release")) >= stamp(built("debug")) ? built("release") : built("debug");
  if (!existsSync(artifact)) throw new Error(`Browser engine missing. Run node AuthoritiesHelper/modern/html/build-engine.mjs${release ? " --release" : ""} first.`);
  if (release && stamp(built("debug")) > stamp(artifact))
    throw new Error("The optimized engine is older than the engine's latest build. Run node AuthoritiesHelper/modern/html/build-engine.mjs --release first.");
  const engine = readFileSync(artifact);
  // The build's own code: a change to how it builds reruns its steps.
  const builder = [import.meta.filename, path.join(here, "runtime-bundle.mjs"),
    path.join(here, "../scripts/authorities-package/bundle.mjs")];
  const viteEnvironment = JSON.stringify(Object.entries(process.env)
    .filter(([name]) => name.startsWith("VITE_") || ['NODE_ENV', 'BEAVER_API_ORIGIN'].includes(name)).sort());
  const [runtime, { html, script, css }, assets, rasterWorker] = await Promise.all([
    cached(cacheDir, app ? `runtime-${app.name}` : "runtime", "", async () => {
      const { code, inputs } = await bundleRuntime({ plugins: app?.runtimePlugins ?? [] });
      const files = bundledFiles(inputs, backend);
      // A contract's TypeScript source, once written, replaces the JavaScript the runtime bundled.
      const contracts = files.flatMap((file) => /[\\/]shared[\\/]runtime[\\/][^\\/]+\.mjs$/u.test(file)
        ? [path.join(repo, "shared/contracts", path.basename(file).replace(/\.mjs$/u, ".mts"))] : []);
      return { value: { code, modules: inputs.length },
        inputs: [...files, ...contracts, ...packageManifests([...files, createRequire(path.join(backend, 'package.json')).resolve('esbuild')]),
          path.join(backend, 'package.json'), path.join(repo, 'shared/package.json'), ...builder] };
    }, backend),
    cached(cacheDir, `frontend-${release ? "release" : "development"}${app ? `-${app.name}` : ""}`,
      sha256(process.version + viteEnvironment + buildFrontend.toString() + bundledFiles.toString() + packageManifests.toString() + (app?.entry ?? "")),
      () => buildFrontend(release, app?.entry), frontend),
    browserOcrAssets(),
    bundleScript("raster-worker.mjs"),
  ]);
  const ocr = { ...assets };
  const pdfWorker = readFileSync(path.join(pdfjs, "legacy/build/pdf.worker.min.mjs"));
  // Named for what is recognized (recognized text is kept by it), before the assets are packed: the
  // PDF.js that draws the pages is part of it.
  const ocrKey = browserOcrKey({ ...ocr, pdfWorker: pdfWorker.toString("base64") });
  // The worker that draws the pages to recognize: page code, like recognize-pdf.mjs, not in the key.
  ocr.rasterWorker = Buffer.from(rasterWorker).toString("base64");
  // Gzip keeps the page small (these assets, the runtime and the fonts go in at a third of their
  // size): the page inflates the runtime as it starts and the recognizer's assets before the first
  // page is read, and the runtime Worker its engine, all off the main thread. Each is compressed
  // once per content; the last build's results are kept for the next.
  const gzipDir = path.join(cacheDir, "gzip"), packedNow = new Set();
  mkdirSync(gzipDir, { recursive: true });
  const gzip = (bytes) => {
    const level = release ? 9 : 1, file = path.join(gzipDir, `${sha256(bytes)}-${level}`);
    packedNow.add(path.basename(file));
    if (existsSync(file)) return readFileSync(file, "utf8");
    const packed = gzipSync(bytes, { level }).toString("base64");
    writeFileSync(`${file}.${process.pid}`, packed);
    renameSync(`${file}.${process.pid}`, file);
    return packed;
  };
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
  for (const name of readdirSync(gzipDir)) if (!packedNow.has(name)) rmSync(path.join(gzipDir, name), { force: true });
  // The payload is data: it goes into the bundled bridge as JSON, not through the bundler.
  const [bridgeHead, ...bridgeTail] = (await bundleScript("page-bridge.mjs",
    { __OCR_RUNTIME_SHA256__: JSON.stringify(ocrKey) })).split("__AUTHORITIES_PAYLOAD__");
  assert.equal(bridgeTail.length, 1, "The page bridge must read its payload once");
  const bridge = bridgeHead + JSON.stringify(payload) + bridgeTail[0];
  // Drop the build's external tags; the page carries everything inline.
  const page = html.replace(/<title>[^<]*<\/title>/u, () => `<title>${app?.title ?? "Authorities"}</title>`)
    .replace(/<script\b[^>]*\bsrc=[^>]*><\/script>\s*/gu, "")
    .replace(/<link\b[^>]*\brel="(?:stylesheet|modulepreload|icon)"[^>]*>\s*/gu, "")
    .replace("</head>", () => `<style>${css.replaceAll("</style", "<\\/style")}</style>\n` +
      `<script>${inline(bridge)}</script>\n</head>`)
    .replace("</body>", () => `<script type="module">${inline(script)}</script>\n</body>`);
  assert(!/\b(?:src|href)="\/(?:assets|src)\//u.test(page), "Authorities.html still references a build file");
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, page);
  return { bytes: Buffer.byteLength(page), runtimeModules: runtime.modules };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const target = process.argv.slice(2).find((value) => !value.startsWith("--"));
  const output = path.resolve(target ?? path.join(here, "../out/Authorities.html"));
  const { bytes } = await buildAuthoritiesHtml(output, { release: process.argv.includes("--release") });
  console.log(`Built ${output} (${bytes} bytes)`);
}
