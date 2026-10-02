// The viewer's PDF.js worker in the self-contained page: carried gzipped by the page bridge and
// handed over as a data: URL (a module worker started from file:// cannot load a blob:null one).
export const pdfWorkerUrl = () => globalThis.AUTHORITIES_PDF_WORKER_URL();
