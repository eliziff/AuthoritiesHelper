// Explicit browser-engine build; HTML assembly only reads these artifacts.
import { cargoEnv } from "../../../scripts/cargo.mjs";
import { spawn, execFileSync } from "node:child_process";
import { constants, setPriority } from "node:os";
import { mkdirSync, renameSync } from "node:fs";
import path from "node:path";

const flags = process.argv.slice(2);
// Unoptimized by default, for the dev loop; --release for a page that ships. --word: the engine of a page that reads no
// PDFs (Authority Linker), Word documents without the PDF parser, beside the full one as legal_structure_node-word.wasm.
const lite = flags.includes("--lite"), release = flags.includes("--release"), word = flags.includes("--word");
if (flags.some(flag => !["--lite", "--release", "--word"].includes(flag)) || lite && word)
  throw new Error("Use build-engine.mjs [--lite | --word] [--release]; Cargo overrides are not accepted");
const profile = release ? "release" : "debug";
// The Beaver checkout being built: the one a build names (BEAVER_CHECKOUT; a worktree reaches this folder by a link),
// else the one holding this folder.
const repo = path.resolve(process.env.BEAVER_CHECKOUT || path.join(import.meta.dirname, "../../.."));
const manifest = path.join(repo, lite ? "AuthoritiesHelper/modern/authorities-lite/engine/Cargo.toml" : "native/legal-structure-node/Cargo.toml");
const target = lite ? "wasm32-unknown-unknown" : "wasm32-wasip1";
// Built in the environment every build of the workspace shares (scripts/cargo.mjs), into its one target folder.
const env = cargoEnv(repo), targetDir = env.CARGO_TARGET_DIR;
// The engine reads the local A2AJ store with SQLite, whose C compiles with wasi-sdk's clang; the Word-only one has neither.
if (!lite && !word) {
  const sdk = process.env.WASI_SDK_PATH;
  if (!sdk) throw new Error("Set WASI_SDK_PATH to a wasi-sdk (github.com/WebAssembly/wasi-sdk/releases): the engine compiles SQLite with it");
  Object.assign(env, { CC_wasm32_wasip1: path.join(sdk, "bin/clang"), AR_wasm32_wasip1: path.join(sdk, "bin/llvm-ar"),
    CFLAGS_wasm32_wasip1: `--sysroot=${path.join(sdk, "share/wasi-sysroot")}` });
}
const child = spawn("cargo", ["build", "--locked", "--offline", ...release ? ["--release"] : [], "--lib",
  ...word ? ["--no-default-features", "--features", "docx"] : [],
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
// Moved, so the full engine's name never holds the Word-only one.
if (word) {
  const built = path.join(targetDir, target, profile, "legal_structure_node.wasm");
  renameSync(built, built.replace(/\.wasm$/u, "-word.wasm"));
}
