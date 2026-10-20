// Inference, line detection, ordering and text geometry reuse the released Legal Browser OCR.
import { orderLayoutLines } from '../../../legal-browser-ocr/layout-order.js';
import { positionedLines } from '../../../legal-browser-ocr/text-layer.js';
import { assetsReady, bytes, assetURL, textAsset } from './assets.mjs';

const recognizersForMemory = gigabytes => gigabytes === undefined ? 2 : gigabytes >= 8 ? 4 : gigabytes > 4 ? 2 : 1;
export const OCR_PARALLEL = Math.max(1, Math.min(recognizersForMemory(globalThis.navigator?.deviceMemory),
  Math.floor((globalThis.navigator?.hardwareConcurrency ?? 2) / 2)));
const idle = [], active = new Set();
const OCR_IDLE_MS = 30_000;
let codec, backend;
async function processingBackend() {
  return backend ??= (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter && !adapter.isFallbackAdapter && adapter.features.has('shader-f16')) return 'webgpu';
    } catch { /* CPU execution remains available without WebGPU. */ }
    return 'wasm';
  })();
}

class IndraOCR {
  constructor(backend) {
    this.backend = backend;
    this.layout = new Worker(assetURL('detectorWorker'));
    this.worker = new Worker(assetURL('recognitionWorker'));
    this.pending = new Map(); this.id = 0;
    this.layout.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id); if (!pending) return;
      this.pending.delete(data.id); data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.lines);
    };
    this.layout.onerror = event => this.dispose(new Error(event.message || 'The line detector failed.'));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(new Error('The local OCR model did not initialize.')), 60_000);
      this.rejectReady = error => { clearTimeout(timer); reject(error); };
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { clearTimeout(timer); resolve(); return; }
        if (data.type === 'error') { this.dispose(new Error(data.message)); return; }
        const pending = this.recognition; this.recognition = undefined;
        pending?.resolve(data.pages[0].lines);
      };
      this.worker.onerror = event => this.dispose(new Error(event.message || 'The local OCR worker failed.'));
      const model = bytes(backend === 'webgpu' ? 'gpuModel' : 'model').slice();
      this.runtimeMjs = assetURL(backend === 'webgpu' ? 'gpuMjs' : 'ortMjs');
      this.runtimeWasm = assetURL(backend === 'webgpu' ? 'gpuWasm' : 'ortWasm');
      this.worker.postMessage({ type: 'init', backend, runtimeMjs: this.runtimeMjs, runtimeWasm: this.runtimeWasm,
        model, codec: codec ??= JSON.parse(textAsset('codec')), recognizer: 'indra',
        batchSize: backend === 'webgpu' ? 32 : 16, bucketSize: 24, sortedBatches: backend === 'webgpu',
        sessionOptions: { graphOptimizationLevel: 'all', logSeverityLevel: 3 } }, [model.buffer]);
    });
  }
  findLines(bitmap) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Large model/runtime URLs are sent only when the worker loads its session.
      try {
        this.layout.postMessage({ id, bitmap, width: bitmap.width, height: bitmap.height,
          modelOptions: { backend: 'indra', longSide: 896, ...(id === 1 && {
            executionProvider: this.backend, modelPath: assetURL('detectorModel'), configPath: assetURL('detectorConfig'),
            runtimeMjs: this.runtimeMjs, runtimeWasm: this.runtimeWasm,
            sessionOptions: { graphOptimizationLevel: 'all', logSeverityLevel: 3 },
          }) } }, [bitmap]);
      } catch (error) { bitmap.close(); this.pending.delete(id); reject(error); }
    });
  }
  async recognize({ bitmap }, signal) {
    try {
      const { width, height } = bitmap;
      signal?.throwIfAborted(); await this.ready; signal?.throwIfAborted();
      const boxes = orderLayoutLines(await this.findLines(await createImageBitmap(bitmap)), width, height);
      signal?.throwIfAborted();
      const lines = boxes.map(b => {
        const x = Math.max(0, b.x0 - 10), y = Math.max(0, b.y0 - 6);
        return { x, y, width: Math.min(width, b.x1 + 11) - x, height: Math.min(height, b.y1 + 7) - y,
          ocrBox: { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 } };
      }).filter(line => line.width > 0 && line.height > 0);
      if (!lines.length) return [];
      const texts = await new Promise((resolve, reject) => {
        this.recognition = { resolve, reject };
        this.worker.postMessage({ type: 'recognize', pages: [{ bitmap, lines }], scale: 1 }, [bitmap]);
      });
      signal?.throwIfAborted(); return positionedLines(lines, texts);
    } finally { bitmap.close(); }
  }
  dispose(error = new DOMException('OCR cancelled', 'AbortError')) {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.ended);
    this.rejectReady?.(error);
    this.layout.terminate(); this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.recognition?.reject(error); this.recognition = undefined;
    active.delete(this);
    const index = idle.indexOf(this); if (index >= 0) idle.splice(index, 1);
  }
}
export function disposeOCR() { for (const ocr of active) ocr.dispose(); }
export async function recognizePage(page, signal) {
  let ocr, abort;
  try {
    signal?.throwIfAborted();
    const backend = await processingBackend(); signal?.throwIfAborted();
    await assetsReady(['recognitionWorker', 'detectorWorker', 'detectorModel',
      ...(backend === 'webgpu' ? ['gpuModel', 'gpuMjs', 'gpuWasm'] : ['model', 'ortMjs', 'ortWasm'])]);
    signal?.throwIfAborted();
    ocr = idle.pop() ?? new IndraOCR(backend); active.add(ocr);
    clearTimeout(ocr.ended);
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
    });
    const reading = ocr.recognize(page, signal);
    // A cancelled caller can return early; the instance is reused only after its work stops.
    reading.then(() => true, error => error?.name === 'AbortError').then(reusable => {
      if (!reusable || active.size > OCR_PARALLEL) { ocr.dispose(); return; }
      if (ocr.disposed) return;
      ocr.ended = setTimeout(() => ocr.dispose(), OCR_IDLE_MS);
      idle.push(ocr);
    });
    return await Promise.race([reading, cancelled]);
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!ocr) page.bitmap.close();
  }
}
