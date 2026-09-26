import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const stage = path.resolve(process.argv[2] ?? "");
const node = path.join(stage, "runtime", "node.exe");
const entry = path.join(stage, "backend", "dist", "authoritiesStandalone.js");
const native = path.join(stage, "runtime", "legal-structure", "legal_structure_node.dll");
const pdfRoot = path.join(stage, "runtime", "legal-pdf-parser");
const buildId = JSON.parse(readFileSync(path.join(stage, "manifest.json"), "utf8")).buildId;
assert.match(buildId, /^[a-f\d]{64}$/u, "Package manifest misses its build identity");
for (const file of [node, entry, native, path.join(stage, "frontend", "dist", "authorities.html"),
  path.join(pdfRoot, "runtime", "onnxruntime.dll"),
  path.join(pdfRoot, "runtime", "legalpdf_tesseract_layout.dll"),
  path.join(pdfRoot, "runtime", "kraken", "model.onnx"),
  path.join(pdfRoot, "runtime", "kraken", "codec.json")]) assert(existsSync(file), `Missing ${file}`);

const probe = spawnSync(node, ["-e",
  "const m={exports:{}};process.dlopen(m,process.argv[1]);" +
  "if(!m.exports.citationLookupKey('R v Jordan, 2016 SCC 27')||" +
  "typeof m.exports.pdfPassageGeometryPages!=='function')process.exit(2)", native]);
assert.equal(probe.status, 0, probe.stderr?.toString() || "Native runtime probe failed");

const port = await new Promise((resolve, reject) => {
  const listener = net.createServer(); listener.once("error", reject);
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address(); listener.close(() => resolve(address.port));
  });
});
const data = await mkdtemp(path.join(os.tmpdir(), "authorities-package-"));
const output = [], server = spawn(node, [entry], { cwd: stage, windowsHide: true,
  env: { ...process.env, PORT: String(port), NODE_ENV: "production",
    AUTHORITIES_BUILD_ID: buildId,
    LEGAL_STRUCTURE_NATIVE: native, LEGALPDF_ENGINE_ROOT: pdfRoot, MIKE_LOCAL_DATA_DIR: data } });
server.stdout.on("data", (chunk) => output.push(chunk));
server.stderr.on("data", (chunk) => output.push(chunk));
try {
  const origin = `http://127.0.0.1:${port}`, deadline = Date.now() + 20_000;
  let health;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try { health = await fetch(`${origin}/health`).then((response) => response.json()); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.deepEqual(health, { status: "ok", app: "authorities", buildId },
    Buffer.concat(output).toString());
  const page = await fetch(`${origin}/authorities.html`);
  const html = await page.text();
  assert(page.ok && /id="root"/u.test(html), "Authorities page was not served");
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu)]
    .map((match) => match[1]);
  assert.equal(assets.length, 2, "Authorities should load one script and one stylesheet");
  for (const asset of assets) {
    const response = await fetch(new URL(asset, origin));
    assert(response.ok && (await response.arrayBuffer()).byteLength > 1_000,
      `Authorities asset was not served: ${asset}`);
  }
  const font = await fetch(`${origin}/pdfjs-standard-fonts/FoxitSerif.pfb`);
  assert(font.ok && (await font.arrayBuffer()).byteLength > 10_000,
    "PDF.js standard fonts were not served");
  const created = await fetch(`${origin}/api/authorities-runtime/create`, { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: { sourceMode: "render" } }) });
  const draft = await created.json();
  assert(created.ok && draft.schemaVersion === "beaver.authorities-draft.v1" &&
    draft.settings.sourceMode === "render",
    "Authorities runtime did not create a draft");
  console.log(`Packaged Authorities passed native and loopback smoke on port ${port}.`);
} finally {
  server.kill(); const stopped = await Promise.race([
    new Promise((resolve) => server.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  await rm(data, { recursive: true, force: true });
  assert(stopped, "Packaged Authorities did not stop cleanly");
}
