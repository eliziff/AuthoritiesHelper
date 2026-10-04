// PDF.js's image decoders in the self-contained page: carried gzipped by the page bridge, which hands
// them to the viewer and the recognizer's PDF.js alike as data: URLs.
export const pdfDecoders = () => globalThis.AUTHORITIES_PDF_DECODERS();
