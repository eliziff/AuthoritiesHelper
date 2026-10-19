// Browser composition of the same PDF preparation operation.
// Provider files are embedded assets, never native filesystem paths.
export function profileFor(provider, layout) {
  if (layout === true) throw new Error('The browser package does not include PPDoc layout.');
  if (provider == null) return {};
  if (provider !== 'indra') throw new Error('This package includes Indra OCR.');
  return { ocr: { provider, settings: {} } };
}
