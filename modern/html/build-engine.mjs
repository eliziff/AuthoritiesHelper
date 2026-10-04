// Explicit browser-engine build; HTML assembly only reads these artifacts.
import "../../../scripts/background-work.mjs";
import { spawn, execFileSync } from "node:child_process";
import { constants, homedir, setPriority } from "node:os";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";

const flags = process.argv.slice(2);
// Unoptimized by default, for the dev loop; --release for a page that ships.
const lite = flags.includes("--lite"), release = flags.includes("--release");
if (flags.some(flag => flag !== "--lite" && flag !== "--release")) throw new Error("Use build-engine.mjs [--lite] [--release]; Cargo overrides are not accepted");
const profile = release ? "release" : "debug";
const repo = path.resolve(import.meta.dirname, "../../..");
const manifest = path.join(repo, lite ? "AuthoritiesHelper/modern/authorities-lite/engine/Cargo.toml" : "native/legal-structure-node/Cargo.toml");
const target = lite ? "wasm32-unknown-unknown" : "wasm32-wasip1";
const targetDir = path.join(repo, "native/legal-structure-node/target");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith("CARGO_PROFILE_") && !(key.startsWith("CARGO_TARGET_") && /_(RUSTFLAGS|LINKER)$/.test(key)) &&
  !["CARGO_TARGET_DIR", "CARGO_BUILD_TARGET", "CARGO_BUILD_RUSTFLAGS", "CARGO_INCREMENTAL",
    "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER"].includes(key)));
env.CARGO_TARGET_DIR = targetDir;
env.CARGO_ENCODED_RUSTFLAGS = [[homedir(), "/home"],
  [process.env.RUSTUP_HOME ?? path.join(homedir(), ".rustup"), "/rustup"],
  [process.env.CARGO_HOME ?? path.join(homedir(), ".cargo"), "/cargo"], [repo, "/beaver"]]
  .map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join("\x1f");
const child = spawn("cargo", ["build", "--locked", "--offline", ...release ? ["--release"] : [],
  "--target", target, "--manifest-path", manifest], { cwd: repo, env, stdio: "inherit" });
// The build yields to interactive work.
child.once("spawn", () => setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL));
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Browser engine build failed (${code})`)));
});
if (lite) {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--offline",
    "--manifest-path", manifest, "--format-version", "1"], { cwd: repo, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const version = metadata.packages.find(pkg => pkg.name === "wasm-bindgen").version;
  if (execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim() !== `wasm-bindgen ${version}`)
    throw new Error(`Install wasm-bindgen-cli ${version} for this engine`);
  const output = path.join(repo, "AuthoritiesHelper/modern/authorities-lite/vendor");
  mkdirSync(output, { recursive: true });
  execFileSync("wasm-bindgen", ["--target", "web", "--no-typescript", "--out-name", "legal-structure",
    "--out-dir", output, path.join(targetDir, target, `${profile}/authorities_browser_engine.wasm`)], { stdio: "inherit" });
  renameSync(path.join(output, "legal-structure_bg.wasm"), path.join(output, "legal-structure.wasm"));
}
