# Modern standalone Authorities

This directory owns the standalone deployments, packaging, and browser checks
for Beaver's shared TypeScript Authorities core: the local loopback package and
the self-contained `Authorities.html`. The obsolete Python application has been removed.

When this repository is checked out as Beaver's `AuthoritiesHelper` submodule,
run from the Beaver root:

```powershell
npm run dev:authorities
npm run package:authorities
```

To restart an already verified staged build without rebuilding either surface:

```powershell
node AuthoritiesHelper/modern/authorities-dev.mjs --reuse-stage
```

This starts the existing artifacts; source changes require rebuilding the affected
stage before reuse.

The package command writes `modern/out/Authorities-win-x64.zip`. Generated
packages and runtimes are never committed.

## Releases

The Release workflow publishes two single-file packages: `Authorities.html`, the full
Authorities app built from Beaver with [html/](html) (tags `authorities-v*`), and
`Authorities-lite.html`, the separate lightweight app in
[authorities-lite/](authorities-lite) (tags `authorities-lite-v*`).

## Self-contained HTML

`Authorities.html` is the same workspace, runtime and Rust engine in one file
that opens from disk in Chrome or Edge. [html/](html) is only the deployment
adapter: the runtime router the loopback server mounts runs in a Web Worker,
`native/legal-structure-node` is compiled for WASI in place of the Node addon,
and Node built-ins resolve to browser equivalents over one in-memory filesystem
shared with the engine. HTML assembly reads the existing browser engine; UI changes do not compile Rust.

HTML assembly reuses the last frontend bundle until its actual Vite module/config,
mode environment or Tailwind watch dependencies change. Unrelated frontend tests,
documents and backend runtime builders do not invalidate it. CSS watch-glob
membership detects new and deleted scan files; a new excluded file matching a
positive watch glob can conservatively invalidate once. Development and delivery
keep separate results, and files changed during assembly leave no reusable result.
Check that boundary without building the app:
`node AuthoritiesHelper/modern/html/build-cache.test.mjs`.

```sh
node AuthoritiesHelper/modern/html/build-engine.mjs
npm run build:authorities-html

# Optimized delivery is explicit:
node AuthoritiesHelper/modern/html/build-engine.mjs --release
npm run build:authorities-html -- --release
```

A2AJ answers browsers directly. Publisher sites do not, so court decisions and official
legislation PDFs come through the provider PDF service, the `quiet-wildflower-ab0d` Worker
built from [authorities-lite/worker.mjs](authorities-lite/worker.mjs); any other source is attached
manually. The HTML package embeds the OCR model, runtime, layout workers and
PDF worker. Scanned pages are recognized in the browser and passed to the
shared PDF parser with their page geometry. The recognition WebAssembly in
[browser-ocr/wasm](browser-ocr/wasm) is rebuilt from pinned ONNX Runtime and
Tesseract sources by `node browser-ocr/wasm/build.mjs`, which installs its own
Emscripten and maps build paths so the files carry none from the build machine.
The explicit engine builder remaps paths for both profiles. Ordinary HTML assembly reads the newest existing debug/release WASI artifact, uses staging frontend transforms and fast gzip; `--release` selects optimized release artifacts and delivery compression.
