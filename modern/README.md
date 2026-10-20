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

Focused OCR storage and asset checks use real Chromium with invented data and no
external services:
`node --test --test-concurrency=1 AuthoritiesHelper/modern/html/ocr-cache.test.mjs AuthoritiesHelper/modern/browser-ocr/assets.test.mjs`.
The full HTML stores completed OCR pages separately and inflates only its selected
CPU/WebGPU assets. Its disposable OCR cache is replaced once when upgrading;
saved drafts stay in their existing store.

Engine builds need [WASI SDK 34](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34)
for SQLite. Set `WASI_SDK_PATH` to its unpacked directory; the release workflow
installs and verifies the Linux SDK itself.

```sh
rustup target add wasm32-wasip1
node AuthoritiesHelper/modern/html/build-engine.mjs
npm run build:authorities-html

# Optimized delivery is explicit:
node AuthoritiesHelper/modern/html/build-engine.mjs --release
npm run build:authorities-html -- --release
```

A2AJ answers browsers directly. Publisher sites do not, so court decisions and official
legislation PDFs come through the provider PDF service, the `quiet-wildflower-ab0d` Worker
built from [authorities-lite/worker.mjs](authorities-lite/worker.mjs). Its bounded
`POST /source` bridge also supports CourtListener, GovInfo and their approved PDF hosts
for networked source acquisition. CanLII is never fetched: its page is linked and its
PDF attached. The new endpoint must be
deployed separately: rebuilding standalone HTML does not update the remote Worker.
Private ALR's existing local program provides the same endpoint after a program
rebuild, so its served pages do not require that remote deployment. The HTML packages embed the
checksum-verified Legal Browser OCR v0.2.2 Balanced Indra recognizer, learned line
detector and CPU SIMD/WebGPU runtimes. Scanned pages are rendered at 144 dpi,
recognized locally and passed to the shared PDF parser with their page geometry.
WebGPU is selected when the browser exposes a suitable adapter with FP16 support;
CPU execution remains available otherwise. The original model terms and restrictions
are embedded with the assets; the weights are not covered by the application's MIT license.
The loopback and native WebView2 programs use the Rust OCR runtime with
automatic GPU selection, CPU fallback and core-based worker limits. Install its assets with
`python legal-pdf-parser/tools/install_ocr_runtime.py` before native packaging.
The package smoke can also read the independently invented Lite scan using only
the packaged addon and OCR assets: pass its fixture directory after the package
stage to `modern/scripts/authorities-package/smoke.mjs`.
The old `browser-ocr/wasm` builder is retained as historical source and does not
build the current runtime.
The explicit engine builder remaps paths for both profiles. Ordinary HTML assembly reads the newest existing debug/release WASI artifact, uses staging frontend transforms and fast gzip; `--release` selects optimized release artifacts and delivery compression.
