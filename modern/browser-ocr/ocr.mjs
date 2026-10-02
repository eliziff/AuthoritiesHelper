// Adapter only: inference, layout, line ordering and PDF text geometry reuse Legal Browser OCR.
import { TesseractLayout } from '../vendor/ocr-source/tesseract-layout.js';
import { orderLayoutLines } from '../vendor/ocr-source/layout-order.js';
import { positionedLines } from '../vendor/ocr-source/text-layer.js';
import { bytes, assetURL, textAsset } from './assets.mjs';

// Each recognizer reads one page at a time on its own workers, so pages are read side by side by
// as many recognizers as the machine has cores to spare; each is small (a 0.7 MB model).
export const OCR_PARALLEL = Math.max(1, Math.min(4, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 2) / 2)));
const idle = [];
let created = 0, codec;
class QualityOCR {
  constructor() {
    this.layout = new TesseractLayout({ workerPath: assetURL('layoutWorker'), corePath: assetURL('layoutCore'),
      wasmPath: assetURL('layoutWasm', 'application/wasm'), sourceResolution: 200, psm: 3 });
    this.worker = new Worker(assetURL('recognitionWorker'));
    this.pending = new Map(); this.id = 0;
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The local OCR model did not initialize.')), 60_000);
      this.rejectReady = error => { clearTimeout(timer); reject(error); };
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'ready') { clearTimeout(timer); resolve(); return; }
        if (data.type === 'error' && data.id == null) { clearTimeout(timer); reject(new Error(data.message)); return; }
        const pending = this.pending.get(data.id); if (!pending) return;
        this.pending.delete(data.id); data.type === 'error' ? pending.reject(new Error(data.message)) : pending.resolve(data.lines);
      };
      this.worker.onerror = event => {
        clearTimeout(timer); const error = new Error(event.message || 'The local OCR worker failed.'); reject(error);
        for (const pending of this.pending.values()) pending.reject(error); this.pending.clear();
      };
      const model = bytes('model').slice();
      this.worker.postMessage({ type: 'init', runtimeMjs: assetURL('ortMjs'), runtimeWasm: assetURL('ortWasm', 'application/wasm'),
        model, codec: codec ??= JSON.parse(textAsset('codec')), batchSize: 32, bucketSize: 24, padding: 16 }, [model.buffer]);
    });
  }
  async recognize(canvas, signal) {
    signal?.throwIfAborted(); await this.ready; signal?.throwIfAborted();
    const boxes = orderLayoutLines(await this.layout.findLines(canvas), canvas.width, canvas.height);
    signal?.throwIfAborted();
    const lines = boxes.map(b => {
      const x = Math.max(0, b.x0 - 10), y = Math.max(0, b.y0 - 6);
      return { x, y, width: Math.min(canvas.width, b.x1 + 11) - x, height: Math.min(canvas.height, b.y1 + 7) - y,
        ocrBox: { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 } };
    }).filter(l => l.width > 0 && l.height > 0);
    if (!lines.length) return [];
    const bitmap = await createImageBitmap(canvas), id = ++this.id;
    const texts = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'recognize', id, bitmap, lines, scale: 1 }, [bitmap]);
    });
    signal?.throwIfAborted(); return positionedLines(lines, texts);
  }
  dispose() {
    this.rejectReady?.(new DOMException('OCR cancelled', 'AbortError'));
    this.layout.terminate(); this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new DOMException('OCR cancelled', 'AbortError'));
    this.pending.clear();
  }
}
export async function recognizePage(canvas, signal) {
  signal?.throwIfAborted();
  const ocr = idle.pop() ?? (created++, new QualityOCR());
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
  });
  const reading = ocr.recognize(canvas, signal);
  // A recognizer waits for the next page once its own is done or given up (it stops at the next
  // step), never while it is still busy: making another costs its model and workers again. One that
  // failed is discarded with its workers.
  reading.then(() => true, (error) => error?.name === 'AbortError').then((reusable) => {
    if (reusable && created <= OCR_PARALLEL) idle.push(ocr); else { ocr.dispose(); created -= 1; }
  });
  try { return await Promise.race([reading, cancelled]); }
  finally { signal?.removeEventListener('abort', abort); }
}
