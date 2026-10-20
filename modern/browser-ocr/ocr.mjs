import { createBrowserOcr } from '../../../legal-browser-ocr/browser-runtime.js';
import { assetsReady, bytes, assetURL } from './assets.mjs';

let runtime;
const current = () => {
  if (!runtime || runtime.disposed) runtime = createBrowserOcr({
    bytes: async name => { await assetsReady([name]); return bytes(name); },
    url: async name => { await assetsReady([name]); return assetURL(name); },
  });
  return runtime;
};
export const ocrParallelism = () => runtime?.configuration?.pageConcurrency ?? 1;
export const prepareOCR = signal => current().prepare(signal);
export const disposeOCR = () => runtime?.dispose();
export const recognizePage = ({ bitmap }, signal) => current().recognizePage(bitmap, signal);
