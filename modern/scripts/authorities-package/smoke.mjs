import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const stage = path.resolve(process.argv[2] ?? "");
const node = path.join(stage, "runtime", "node.exe");
const entry = path.join(stage, "backend", "dist", "authoritiesStandalone.js");
const native = path.join(stage, "runtime", "legal-structure", "legal_structure_node.dll");
const pdfRoot = path.join(stage, "runtime", "legal-pdf-parser");
const buildId = JSON.parse(readFileSync(path.join(stage, "manifest.json"), "utf8")).buildId;
assert.match(buildId, /^[a-f\d]{64}$/u, "Package manifest misses its build identity");
for (const file of [node, entry, native, path.join(stage, "frontend", "dist", "authorities.html"),
  path.join(pdfRoot, "runtime", "onnx", "onnxruntime.dll"),
  path.join(pdfRoot, "runtime", "onnx", "DirectML.dll"),
  path.join(pdfRoot, "runtime", "indra", "manifest.json")]) assert(existsSync(file), `Missing ${file}`);

const adapter = pathToFileURL(path.join(process.env.BEAVER_CHECKOUT ??
  path.resolve(import.meta.dirname, "../../../.."), "shared/structure-engine.mjs")).href;
// The optional Lite fixture directory checks inference from packaged assets too.
const fixture = process.argv[3] ? path.resolve(process.argv[3]) : "";
const probeScript = `
  import assert from 'node:assert/strict';
  import {readFileSync} from 'node:fs';
  import {randomUUID} from 'node:crypto';
  import path from 'node:path';
  const m={exports:{}};process.dlopen(m,process.argv[1]);
  const {structureEngineAddon}=await import(process.argv[2]);
  const engine=structureEngineAddon(m.exports);
  assert(engine.citationLookupKey('2032 ABKB 731'));
  assert(engine.nativeBuildFeatures().includes('legalpdf'));
  if(process.argv[4]) {
    const document=await engine.derivePdfDocument(readFileSync(path.join(process.argv[4],'synthetic-scan.pdf')),{
      id:'machine_test-package-ocr-'+randomUUID(),cache_dir:path.join(process.argv[5],'parser-cache'),
      ocr:{provider:'indra',settings:{
        model_pack:path.join(process.argv[3],'runtime/indra'),
        runtime:path.join(process.argv[3],'runtime/onnx/onnxruntime.dll'),
        backend:'cpu',workers:1,threads:1,layout_workers:1,batch_size:16,width_bucket:24}}});
    const summary=engine.pdfDocumentSummary(document);
    assert.equal(summary.pageCount,1);assert.equal(summary.pagesNeedingOcr.length,0);
    const normalized=value=>value.normalize('NFKC').replace(/\\s+/gu,' ').trim();
    const text=normalized(engine.pdfRecognizedText(document).flatMap(page=>page.lines.map(line=>line.text)).join(' '));
    const gold=normalized(readFileSync(path.join(process.argv[4],'synthetic-gold.txt'),'utf8'));
    const row=Array.from({length:gold.length+1},(_,i)=>i);
    for(let i=0;i<text.length;i++) {
      let previous=row[0];row[0]=i+1;
      for(let j=0;j<gold.length;j++) {
        const old=row[j+1];row[j+1]=Math.min(old+1,row[j]+1,previous+Number(text[i]!==gold[j]));previous=old;
      }
    }
    assert(gold.length && row[gold.length]/gold.length<.12,'invented scan CER exceeds 12%');
  }
`;

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
  const probe = spawnSync(node, ["--input-type=module", "-e", probeScript,
    native, adapter, pdfRoot, fixture, data], { timeout: 120_000,
    env: { ...process.env, MIKE_LOCAL_DATA_DIR: data } });
  assert.equal(probe.status, 0, probe.stderr?.toString() || "Native runtime probe failed");
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
