const urls = new Map(), decoded = new Map(), dataUrls = new Map();
// Match Legal Browser OCR: a file-origin child worker cannot import sibling blob:null modules, and
// a module worker started from a blob:null script never runs. These go to workers as data: URLs.
const DATA_URLS = { ortMjs: 'application/javascript', ortWasm: 'application/wasm',
  layoutCore: 'application/javascript', layoutWasm: 'application/wasm', pdfWorker: 'application/javascript' };
/** The assets the page carries gzipped (the build names them), inflated by assetsReady. */
const packed = () => new Set(globalThis.AUTHORITIES_ASSETS?.gzip ?? []);
function packedValue(name) {
  const value = globalThis.AUTHORITIES_ASSETS?.[name];
  if (!value) throw new Error(`The packaged runtime is missing ${name}.`);
  return value;
}
function base64Bytes(value) {
  const text = atob(value), out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index);
  return out;
}
const asDataUrl = (bytes, type) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(new Blob([bytes], { type }));
});
let unpacking;
/** Inflates the assets the page carries gzipped, once a page and off the main thread: every
 *  recognizer and PDF.js worker waits on it before it starts. */
export function assetsReady() {
  return unpacking ??= Promise.all([...packed()].map(async (name) => {
    const stream = new Blob([base64Bytes(packedValue(name))]).stream().pipeThrough(new DecompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    decoded.set(name, bytes);
    if (DATA_URLS[name]) dataUrls.set(name, await asDataUrl(bytes, DATA_URLS[name]));
  }));
}
/** An embedded asset's bytes, decoded once a page (a recognizer made again does not decode its
 *  model again); a caller that hands them to a worker sends a copy. */
export function bytes(name) {
  if (!decoded.has(name)) {
    if (packed().has(name)) throw new Error(`${name} was asked for before the packaged runtime was ready.`);
    decoded.set(name, base64Bytes(packedValue(name)));
  }
  return decoded.get(name);
}
export function assetURL(name, mime = 'application/javascript') {
  if (DATA_URLS[name]) {
    if (!dataUrls.has(name)) {
      if (packed().has(name)) throw new Error(`${name} was asked for before the packaged runtime was ready.`);
      dataUrls.set(name, `data:${DATA_URLS[name]};base64,${packedValue(name)}`);
    }
    return dataUrls.get(name);
  }
  if (!urls.has(name)) urls.set(name, URL.createObjectURL(new Blob([bytes(name)], { type: mime })));
  return urls.get(name);
}
export function textAsset(name) { return new TextDecoder().decode(bytes(name)); }
