# Modern standalone Authorities

This directory owns the standalone deployments, packaging, and browser checks
for Beaver's shared TypeScript Authorities core: the local loopback package and
the self-contained `Authorities.html`. The obsolete Python application has been removed.

When this repository is checked out as Beaver's `AuthoritiesHelper` submodule,
run from the Beaver root:

```powershell
npm run dev:authorities
npm run test:authorities-package
npm run package:authorities
```

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
shared with the engine. The bundle checks are the loopback package's.

```sh
cargo build --locked --release --target wasm32-wasip1 --manifest-path native/legal-structure-node/Cargo.toml
npm run build:authorities-html
```

A2AJ answers browsers directly. Publisher sites do not, so remote source
retrieval goes through the relay Worker in [html/relay-worker.mjs](html/relay-worker.mjs),
which reaches only the resolver's legal-source hosts and never CanLII. Deploy it
with `node html/build.mjs --relay` and
`npx wrangler deploy --config html/relay-wrangler.jsonc`, then build with
`AUTHORITIES_RELAY_URL` set to its address. Without it, sources are attached
manually. The HTML package embeds the OCR model, runtime, layout workers and
PDF worker. Scanned pages are recognized in the browser and passed to the
shared PDF parser with their page geometry. The recognition WebAssembly in
[browser-ocr/wasm](browser-ocr/wasm) is rebuilt from pinned ONNX Runtime and
Tesseract sources by `node browser-ocr/wasm/build.mjs`, which installs its own
Emscripten and maps build paths so the files carry none from the build machine.
The HTML build compiles the engine with the same mapping, and the release checks
the page with Beaver's `scripts/check_privacy.py --artifact`.
