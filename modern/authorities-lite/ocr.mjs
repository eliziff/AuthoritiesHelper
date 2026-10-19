import { recognizePage as recognizeBitmap } from '../browser-ocr/ocr.mjs';
export { disposeOCR } from '../browser-ocr/ocr.mjs';

export async function recognizePage(canvas, signal) {
  return recognizeBitmap({ bitmap: await createImageBitmap(canvas) }, signal);
}
