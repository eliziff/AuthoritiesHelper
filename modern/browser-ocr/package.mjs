// One pinned browser recognizer for both standalone Authorities packages.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const OCR_RUNTIME_SHA256 = '3bae23ff346b05805e437868dae809a505255caab9c3a9dac61195404a182ad3';
const vendor = path.resolve(import.meta.dirname, '../vendor'), runtime = path.join(vendor, 'runtime');
// Both standalone pages use the released Balanced Indra models, detector and CPU/GPU runtimes.
const files = {
  model: path.join(runtime, 'assets/indra-followup/student8ids/model.onnx'),
  gpuModel: path.join(runtime, 'assets/indra-followup/gpu8h/model.onnx'),
  codec: path.join(runtime, 'assets/indra-followup/student8ids/codec.json'),
  ortMjs: path.join(runtime, 'dist/ort-wasm-simd-threaded.mjs'),
  ortWasm: path.join(runtime, 'dist/ort-wasm-simd-threaded.wasm'),
  gpuMjs: path.join(runtime, 'dist/ort-wasm-simd-threaded.jsep.mjs'),
  gpuWasm: path.join(runtime, 'dist/ort-wasm-simd-threaded.jsep.wasm'),
  recognitionWorker: path.join(runtime, 'dist/recognition-worker.js'),
  detectorWorker: path.join(runtime, 'dist/detector-worker.js'),
  detectorModel: path.join(runtime, 'assets/detectors/indra/model.onnx'),
  detectorConfig: path.join(runtime, 'assets/detectors/config.json'),
  packageNotice: path.join(runtime, 'assets/manifest.json'),
};

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function unpack(bytes, destination, strip = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'authorities-ocr-'));
  try {
    const archive = path.join(temporary, 'input.tar.gz');
    await fs.writeFile(archive, bytes);
    await fs.mkdir(destination, { recursive: true });
    execFileSync('tar', ['-xzf', archive, ...(strip ? ['--strip-components=1'] : []), '-C', destination]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function prepareBrowserOcr() {
  const runtime = process.env.AUTHORITIES_OCR_RUNTIME
    ? await fs.readFile(process.env.AUTHORITIES_OCR_RUNTIME)
    : await download('https://github.com/eliziff/legal-browser-ocr/releases/download/v0.2.0/legal-browser-ocr-runtime.tar.gz');
  if (crypto.createHash('sha256').update(runtime).digest('hex') !== OCR_RUNTIME_SHA256)
    throw new Error('OCR runtime checksum mismatch.');
  await unpack(runtime, path.join(vendor, 'runtime'));
}

export async function browserOcrAssets() {
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) =>
    [name, (await fs.readFile(file)).toString('base64')])));
}
/** Names this recognizer, so text recognized by another build is not reused. */
export const browserOcrKey = (assets) => crypto.createHash('sha256')
  .update(JSON.stringify(Object.entries(assets).sort())).digest('hex');

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await prepareBrowserOcr();
