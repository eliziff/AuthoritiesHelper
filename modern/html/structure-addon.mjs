// The legal-structure engine's Node-API surface, backed by the same Rust crate
// compiled to WebAssembly (native/legal-structure-node, wasm32-wasip1).
// Method names, argument order and sync/async behaviour match the Node addon.

const ASYNC = new Set(["deriveDocumentStructure", "deriveDocumentFingerprint",
  "fixDocxSupraCrossReferences", "hasDocxSupraReferences", "deriveDocxDocument", "docxText",
  "docxAuthorityTextUnits", "derivePdfDocument", "preparePdfDocument", "restorePdfDocument",
  "pdfPassageGeometryPages"]);
// Positional Node-API arguments, named as the WebAssembly binding reads them.
// "bytes" travels as raw bytes; "document" is a handle.
const SIGNATURES = {
  nativeBuildFeatures: [],
  deriveDocumentStructure: ["request"], deriveDocumentFingerprint: ["request"],
  fixDocxSupraCrossReferences: ["bytes"], hasDocxSupraReferences: ["bytes"],
  deriveDocxDocument: ["bytes", "id", "drafting"], docxText: ["bytes", "drafting", "limit"],
  docxAuthorityTextUnits: ["bytes"],
  derivePdfDocument: ["bytes", "request"], preparePdfDocument: ["bytes", "request"],
  restorePdfDocument: ["request"],
  pdfDocumentSummary: ["document"], pdfRecognizedText: ["document", "pages"],
  pdfAuthorityTextUnits: ["document"], pdfPassageGeometryPages: ["document", "bytes", "targets"],
  pdfLookupUnitSpans: ["document", "ids"],
  queryPdfDocument: ["document", "locatorKind", "locator", "endLocator", "contextBlocks", "page", "occurrence"],
  docxStructureLint: ["document"],
  documentText: ["document", "limit"], documentTextBytes: ["document"], documentRevision: ["document"],
  readDocumentTextWindow: ["document", "offset", "startChar", "limit"],
  readDocumentTextRange: ["document", "start", "end", "offset", "limit"],
  documentFingerprint: ["document"], documentAnchors: ["document", "end"],
  legalSourceViewer: ["document", "primaryKind", "limit"], documentTableCells: ["document"],
  citationLookupKey: ["text"], citationLookupKeys: ["texts"], providerCitationsInText: ["text"],
  citationOccurrencesInText: ["text"], authorityReferencesInText: ["text"],
  caselawCitationLookupKey: ["text"], hasCitationInText: ["text"],
  classifyCitatorExcerpt: ["text"], classifyCitatorExcerpts: ["texts"],
  groundedProseErrors: ["text", "citedEvidenceIds", "visibleEvidence"],
  quoteRepairSuggestion: ["claim", "spans"], markedQuoteSpans: ["text"],
  readDocumentRange: ["document", "kind", "from", "to", "contextBlocks"],
  smallestContainingDocumentBlock: ["document", "start", "end"],
  textFragmentPlan: ["blockText", "quotes", "pdf", "publisherMayAnnotateLegalReference",
    "splitHtmlSourceBlocks", "document"],
  textFragmentPlanStandalone: ["blockText", "quotes", "pdf", "publisherMayAnnotateLegalReference",
    "splitHtmlSourceBlocks"],
  documentParagraphRangeDirective: ["document", "start", "end"],
  lookupStructureBlock: ["document", "locator", "contextBlocks"],
  resolveDocumentAddressSpans: ["document", "spec", "follow", "depth"],
  graphScope: ["document", "seedLabel", "follow", "depth", "includeDescendants", "includeUnits"],
  documentHasOrigin: ["document", "origin"],
};
const DOCUMENT_RESULTS = new Set(["deriveDocumentStructure", "deriveDocxDocument",
  "derivePdfDocument", "restorePdfDocument"]);

/** An opaque engine document, released when JavaScript no longer references it. */
class NativeDocumentHandle { constructor(handle) { this.handle = handle; } }

/**
 * @param {WebAssembly.Instance} instance the WASI-initialized engine module
 * @param {(bytes: Uint8Array) => Uint8Array} toBuffer wraps result bytes as the host's Buffer
 */
export function createStructureAddon(instance, toBuffer = (bytes) => bytes) {
  const wasm = instance.exports, encoder = new TextEncoder(), decoder = new TextDecoder();
  const released = new FinalizationRegistry((handle) => {
    try { call("releaseDocument", { document: handle }); } catch { /* engine already reset */ }
  });
  function call(op, args, bytes = new Uint8Array()) {
    const json = encoder.encode(JSON.stringify({ op, args }));
    const length = 4 + json.length + bytes.length, input = wasm.authorities_alloc(length);
    let view = new Uint8Array(wasm.memory.buffer, input, length);
    new DataView(view.buffer, input, 4).setUint32(0, json.length, true);
    view.set(json, 4); view.set(bytes, 4 + json.length);
    const output = wasm.authorities_call(input, length);
    wasm.authorities_free(input, length);
    const head = new DataView(wasm.memory.buffer, output, 9);
    const size = head.getUint32(0, true), ok = head.getUint8(4), jsonLength = head.getUint32(5, true);
    view = new Uint8Array(wasm.memory.buffer, output + 9, size - 5).slice();
    wasm.authorities_free(output, size + 4);
    const text = decoder.decode(view.subarray(0, jsonLength));
    if (!ok) throw new Error(text);
    return { value: JSON.parse(text), bytes: view.subarray(jsonLength) };
  }
  function invoke(name, positional) {
    const args = {}; let bytes;
    SIGNATURES[name].forEach((key, index) => {
      const value = positional[index];
      if (key === "bytes") bytes = value;
      else if (key === "document") args.document = value?.handle;
      else args[key] = value ?? null;
    });
    const { value, bytes: out } = call(name, args, bytes && new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (DOCUMENT_RESULTS.has(name)) {
      if (!value) return null;
      const document = new NativeDocumentHandle(value.handle);
      released.register(document, value.handle); return document;
    }
    if (name === "fixDocxSupraCrossReferences") return { ...value, bytes: toBuffer(out) };
    return value;
  }
  const addon = {};
  for (const name of Object.keys(SIGNATURES)) addon[name] = ASYNC.has(name)
    ? (...positional) => new Promise((resolve) => resolve(invoke(name, positional)))
    : (...positional) => invoke(name, positional);
  return addon;
}
