# Modern standalone Authorities

This directory owns the standalone deployments, packaging, and browser checks
for Beaver's shared TypeScript Authorities core: the local loopback package and
the self-contained `Authorities.html`. The Python application remains available
at the repository root.

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
npm run test:authorities:html
```

A2AJ answers browsers directly. Publisher sites do not, so remote source
retrieval goes through the relay Worker in [html/relay-worker.mjs](html/relay-worker.mjs),
which reaches only the resolver's legal-source hosts and never CanLII. Deploy it
with `node html/build.mjs --relay` and
`npx wrangler deploy --config html/relay-wrangler.jsonc`, then build with
`AUTHORITIES_RELAY_URL` set to its address. Without it, sources are attached
manually. Scanned-PDF recognition uses the native OCR runtime, which the browser
build does not include; choose to keep scanned pages as images there.
