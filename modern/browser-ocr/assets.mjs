const urls = new Map(), decoded = new Map();
/** An embedded asset's bytes, decoded once a page (a recognizer made again does not decode its
 *  model again); a caller that hands them to a worker sends a copy. */
export function bytes(name) {
  if (!decoded.has(name)) {
    const value = globalThis.AUTHORITIES_ASSETS?.[name];
    if (!value) throw new Error(`The packaged runtime is missing ${name}.`);
    const text = atob(value), out = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index);
    decoded.set(name, out);
  }
  return decoded.get(name);
}
export function assetURL(name, mime = 'application/javascript') {
  // Match Legal Browser OCR: a file-origin child worker cannot import sibling blob:null modules, and
  // a module worker started from a blob:null script never runs.
  if (['ortMjs','ortWasm','layoutCore','layoutWasm','pdfWorker'].includes(name)) {
    const data = globalThis.AUTHORITIES_ASSETS?.[name];
    if (!data) throw new Error(`The packaged runtime is missing ${name}.`);
    return `data:${mime};base64,${data}`;
  }
  if (!urls.has(name)) urls.set(name, URL.createObjectURL(new Blob([bytes(name)], { type: mime })));
  return urls.get(name);
}
export function textAsset(name) { return new TextDecoder().decode(bytes(name)); }
