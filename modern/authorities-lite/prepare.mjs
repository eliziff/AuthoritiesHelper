// Download only the shared OCR model/runtime assets; source comes from owning checkouts.
import { prepareBrowserOcr } from '../browser-ocr/package.mjs';
await prepareBrowserOcr();
