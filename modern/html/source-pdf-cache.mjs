// Publisher PDFs the page has verified, asked of the page from the runtime Worker. The page keeps
// them in its own store (IndexedDB) by URL and content hash, so a later import or visit does not
// fetch them again; this Worker's memory holds them only for one visit.
import { hasPdfEndMarker } from "../../../shared/pdf-integrity.mjs";

const waiting = new Map();
let next = 0;

/** The bytes the page kept for this URL, or null. */
export function keptPdf(url) {
  const id = ++next;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    self.postMessage({ type: "source-pdf", id, url });
  });
}
export function pageAnswered({ id, bytes }) {
  waiting.get(id)?.(bytes ?? null);
  waiting.delete(id);
}

/** Asks the page to keep a whole PDF: one that starts as a PDF and ends with its end marker. */
export async function keepPdf(url, bytes) {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-" || !hasPdfEndMarker(bytes)) return;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  self.postMessage({ type: "source-pdf-fetched", url,
    sha256: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") });
}
