import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildAuthoritiesFrontend, bundleAuthorities } from "./authorities-package/bundle.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const stage = path.join(import.meta.dirname, ".authorities-dev");
const library = path.join(root, "native/legal-structure-node/target/release",
  process.platform === "win32" ? "legal_structure_node.dll" :
    process.platform === "darwin" ? "liblegal_structure_node.dylib" : "liblegal_structure_node.so");
const native = process.env.LEGAL_STRUCTURE_NATIVE || library;
if (!existsSync(native)) throw new Error(
  "Build the pinned native engine first: cargo build --locked --release --manifest-path native/legal-structure-node/Cargo.toml");
await buildAuthoritiesFrontend(stage);
await bundleAuthorities(stage);
const entry = path.join(stage, "backend/dist/authoritiesStandalone.js");
const buildId = createHash("sha256").update(readFileSync(entry))
  .update(readFileSync(path.join(stage, "frontend/dist/authorities.html"))).digest("hex");
const child = spawn(process.execPath, [entry], { cwd: root, stdio: "inherit",
  env: { ...process.env, PORT: process.env.PORT || "3002", AUTHORITIES_BUILD_ID: buildId,
    LEGAL_STRUCTURE_NATIVE: path.resolve(native) } });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 0; });
