import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// AuthoritiesHelper owns this deployment adapter; Beaver supplies the shared core.
const repo = path.resolve(import.meta.dirname, "../../../..");
const backend = path.join(repo, "backend");
const frontend = path.join(repo, "frontend");
const backendRequired = [
  "src/authoritiesStandalone.ts",
  "src/authoritiesStandaloneServer.ts",
  "src/routes/authoritiesRuntime.ts",
  "src/lib/authoritiesBuild.ts",
];
// Pure validation (Zod) is part of the shared runtime contract, not a Beaver
// deployment dependency. Keep its real validators and error types in this bundle.
export const backendForbidden = [
  /(?:^|\/)src\/(?:index|runtime|supervisor)\.ts$/u,
  /(?:^|\/)src\/middleware\/auth\.ts$/u,
  /(?:^|\/)src\/lib\/(?:jobQueue|relational(?:Database)?|supabase)\.ts$/u,
  /(?:^|\/)src\/lib\/spreadsheet\.ts$/u,
  /(?:^|\/)src\/lib\/chat\//u,
  /(?:^|\/)node_modules\/(?:@anthropic-ai|@aws-sdk|@google\/genai|@supabase|openai|postal-mime|postgres|xlsx)\//u,
];
const slash = (value) => value.replaceAll("\\", "/");
const frontendRequired = ["/src/authoritiesMain.tsx",
  "/src/app/authorities/AuthoritiesWorkspace.tsx",
  "/src/app/authorities/standaloneHost.ts",
  "/src/app/lib/standaloneWorkProducts.ts"];
export const frontendForbidden = [/\/src\/app\/authorities\/beaverHost\.ts$/u,
  /\/src\/app\/components\/assistant\//u,
  /\/src\/app\/lib\/(?:api\/(?!(?:client|mutationEvents)\.)[^/]+|supabase)\.[^/]+$/u,
  /\/node_modules\/(?:@anthropic-ai|@aws-sdk|@google\/genai|@supabase|openai)\//u];

export function assertAuthoritiesBundle(metafile) {
  const inputs = Object.keys(metafile?.inputs ?? {}).map(slash);
  for (const file of backendRequired)
    assert(inputs.includes(file), `Authorities bundle misses ${file}`);
  for (const file of inputs) for (const pattern of backendForbidden)
    assert(!pattern.test(file), `Authorities bundle contains ${file}`);
}

export function assertStandaloneFrontendModules(inputs) {
  const modules = [...new Set(inputs.map((value) => slash(value).split("?")[0]))];
  for (const suffix of frontendRequired)
    assert(modules.some((file) => file.endsWith(suffix)), `Authorities frontend misses ${suffix}`);
  for (const file of modules) for (const pattern of frontendForbidden)
    assert(!pattern.test(file), `Authorities frontend contains ${file}`);
}

function packageRoot(input, base) {
  const parts = slash(path.resolve(base, input)).split("/"), index = parts.lastIndexOf("node_modules");
  if (index < 0 || !parts[index + 1]) return null;
  return parts.slice(0, index + (parts[index + 1].startsWith("@") ? 3 : 2)).join("/");
}

export function writeThirdPartyNotices(stage, inputs, base, prefix) {
  const packages = [...new Set(inputs.map((input) => packageRoot(input, base)).filter(Boolean))]
    .sort();
  const records = [], notices = [];
  for (const root of packages) {
    const manifest = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"));
    const files = readdirSync(root).filter((name) => /^(?:licen[cs]e|notice|copying)(?:\.|$)/iu.test(name));
    records.push({ name: manifest.name, version: manifest.version, license: manifest.license ?? null,
      files });
    for (const file of files) notices.push(
      `===== ${manifest.name}@${manifest.version}: ${file} =====\n` +
      readFileSync(path.join(root, file), "utf8").trim());
  }
  const licenses = path.join(stage, "licenses"); mkdirSync(licenses, { recursive: true });
  writeFileSync(path.join(licenses, `${prefix}-packages.json`),
    `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(path.join(licenses, `${prefix}-licenses.txt`), `${notices.join("\n\n")}\n`);
}

export const localOnly = {
  name: "authorities-local-only",
  setup(build) {
    build.onResolve({ filter: /^\.\/jobQueue$/ }, ({ importer }) =>
      slash(importer).endsWith("/src/lib/providerPdfLibraryBridge.ts")
        ? { path: "jobs", namespace: "authorities-local" } : null);
    build.onResolve({ filter: /^\.\/spreadsheet$/ }, ({ importer }) =>
      slash(importer).endsWith("/src/lib/documentProjectionService.ts")
        ? { path: "spreadsheet", namespace: "authorities-local" } : null);
    build.onResolve({ filter: /^\.\/emailText$/ }, ({ importer }) =>
      slash(importer).endsWith("/src/lib/documentProjectionService.ts")
        ? { path: "email", namespace: "authorities-local" } : null);
    build.onLoad({ filter: /.*/, namespace: "authorities-local" }, ({ path: name }) => ({
      loader: "js",
      contents: name === "email"
          ? "export const extractEmailText=async()=>{throw new Error('Authorities accepts PDF and Word files only')};"
        : name === "spreadsheet"
          ? "const no=async()=>{throw new Error('Authorities accepts PDF and Word files only')};export const spreadsheetToLLMStructure=no,spreadsheetToLLMText=no;"
        : "export const enqueueJob = async () => { throw new Error('Jobs are unavailable in standalone Authorities'); };",
    }));
  },
};

export async function bundleAuthorities(stage) {
  const require = createRequire(path.join(backend, "package.json"));
  const { build } = require("esbuild");
  const output = path.join(stage, "backend", "dist"); mkdirSync(output, { recursive: true });
  const result = await build({ absWorkingDir: backend, entryPoints: ["src/authoritiesStandalone.ts"],
    outfile: path.join(output, "authoritiesStandalone.js"), bundle: true, platform: "node",
    format: "cjs", target: "node22", minifySyntax: true, minifyWhitespace: true,
    legalComments: "none", metafile: true, plugins: [localOnly] });
  assertAuthoritiesBundle(result.metafile);
  writeThirdPartyNotices(stage, Object.keys(result.metafile.inputs), backend, "npm");
}

export async function buildAuthoritiesFrontend(stage) {
  const require = createRequire(path.join(frontend, "package.json"));
  const { build, loadConfigFromFile } = await import(
    pathToFileURL(require.resolve("vite")).href);
  const loaded = await loadConfigFromFile({ command: "build", mode: "production" },
    path.join(frontend, "vite.config.ts"), frontend);
  assert(loaded, "Authorities could not load the frontend build config");
  const result = await build({ ...loaded.config, root: frontend, configFile: false,
    build: { ...loaded.config.build, outDir: path.join(stage, "frontend", "dist"),
      emptyOutDir: true, rolldownOptions: { ...loaded.config.build?.rolldownOptions,
        input: { authorities: path.join(frontend, "authorities.html") } } } });
  const outputs = Array.isArray(result) ? result : [result];
  const modules = outputs.flatMap(({ output }) => output.flatMap((item) =>
    item.type === "chunk" ? Object.keys(item.modules) : []));
  assertStandaloneFrontendModules(modules);
  writeThirdPartyNotices(stage, modules, frontend, "frontend-npm");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const stage = process.argv[2] && path.resolve(process.argv[2]);
  assert(stage, "Usage: node bundle.mjs <stage-directory>");
  await buildAuthoritiesFrontend(stage); await bundleAuthorities(stage);
}
