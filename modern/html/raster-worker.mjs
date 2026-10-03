// Draws the pages the recognizer reads, off the page's main thread: PDF.js opens each source in its
// own worker, started here, and draws each page here on an OffscreenCanvas. The page's pixels (for
// the layout worker) and an ImageBitmap of it (for the recognition worker) go back as transferables.
import { getDocument, PDFWorker } from 'pdfjs-dist/build/pdf.mjs';

let worker, imageDecoder;
const documents = new Map();
// What PDF.js asks of a document, for its canvases and fonts, from this worker's own.
const ownerDocument = { fonts: self.fonts, createElement: () => new OffscreenCanvas(1, 1) };
// PDF.js draws transfer functions and luminosity soft masks with SVG filters, which only a document
// has: here pages are drawn without them.
class FilterFactory { addFilter() { return 'none'; } addAlphaFilter() { return 'none'; } addLuminosityFilter() { return 'none'; } destroy() {} }

async function draw(source, index) {
  const page = await (await documents.get(source).promise).getPage(index + 1);
  try {
    const raw = page.view, rotated = page.rotate % 180 !== 0;
    const width = raw[rotated ? 3 : 2] - raw[rotated ? 1 : 0];
    const height = raw[rotated ? 2 : 3] - raw[rotated ? 0 : 1];
    let viewport = page.getViewport({ scale: 200 / 72 });
    if (viewport.width * viewport.height > 12_000_000)
      viewport = page.getViewport({ scale: viewport.scale * Math.sqrt(12_000_000 / (viewport.width * viewport.height)) });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: context, viewport }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data.buffer, bitmap = canvas.transferToImageBitmap();
    return [{ width, height, viewportWidth: viewport.width, viewportHeight: viewport.height, pixels, bitmap }, [pixels, bitmap]];
  } finally { page.cleanup(); }
}

self.onmessage = async ({ data }) => {
  // First, PDF.js's worker as a data: URL (a module worker started from a file:// page cannot load a
  // blob:null one), and whether to decode JPEG with the browser, as the page's PDF.js would: it asks
  // `globalThis.chrome`, which a worker lacks.
  if (data.pdfWorker) { worker = new PDFWorker({ port: new Worker(data.pdfWorker, { type: 'module' }) }); imageDecoder = data.imageDecoder; return; }
  if (data.close) { void documents.get(data.close)?.destroy(); documents.delete(data.close); return; }
  try {
    if (data.open) {
      documents.set(data.open, getDocument({ data: data.bytes, isEvalSupported: false, useSystemFonts: true,
        isImageDecoderSupported: imageDecoder, ownerDocument, FilterFactory, worker }));
      self.postMessage({ id: data.id, pages: (await documents.get(data.open).promise).numPages });
      return;
    }
    const [answer, transfer] = await draw(data.source, data.page);
    self.postMessage({ id: data.id, ...answer }, transfer);
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
