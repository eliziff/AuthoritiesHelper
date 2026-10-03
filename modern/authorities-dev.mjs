import { nativeAddonFile } from "../../shared/nativeAddonFile.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildAuthoritiesFrontend, bundleAuthorities } from "./scripts/authorities-package/bundle.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const stage = path.join(import.meta.dirname, ".authorities-dev");
const library = path.join(root, "native/legal-structure-node/target/release",
  process.platform === "win32" ? "legal_structure_node.dll" :
    process.platform === "darwin" ? "liblegal_structure_node.dylib" : "liblegal_structure_node.so");
const native = process.env.LEGAL_STRUCTURE_NATIVE || library;
// The bundle runs from the stage directory, so name the PDF engine's runtime assets explicitly.
const pdfEngine = process.env.LEGALPDF_ENGINE_ROOT || path.join(root, "legal-pdf-parser");
if (!existsSync(native)) throw new Error(
  "Build the pinned native engine first: npm run native:build");
if (!process.argv.includes("--reuse-stage")) {
  await buildAuthoritiesFrontend(stage);
  await bundleAuthorities(stage);
}
const entry = path.join(stage, "backend/dist/authoritiesStandalone.js");
if (!existsSync(entry) || !existsSync(path.join(stage, "frontend/dist/authorities.html")))
  throw new Error("Staged Authorities build missing. Run npm run dev:authorities first.");
const buildId = createHash("sha256").update(readFileSync(entry))
  .update(readFileSync(path.join(stage, "frontend/dist/authorities.html"))).digest("hex");
const child = spawn(process.execPath, [entry], { cwd: root, stdio: "inherit",
  env: { ...process.env, PORT: process.env.PORT || "3002", AUTHORITIES_BUILD_ID: buildId,
    LEGAL_STRUCTURE_NATIVE: nativeAddonFile(path.resolve(native), path.join(root, "native/legal-structure-node")), LEGALPDF_ENGINE_ROOT: path.resolve(pdfEngine) } });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 0; });
