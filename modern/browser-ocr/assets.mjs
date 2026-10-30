import { inflateAsset } from "./packed-asset.mjs";
const urls = new Map(), decoded = new Map(), dataUrls = new Map();
// Match Legal Browser OCR: a file-origin child worker cannot import sibling blob:null modules, and
// a module worker started from a blob:null script never runs. These go to workers as data: URLs.
const DATA_URLS = { ortMjs: 'application/javascript', ortWasm: 'application/wasm',
  gpuMjs: 'application/javascript', gpuWasm: 'application/wasm',
  indraDetector: 'application/octet-stream', detectorConfig: 'application/json', pdfWorker: 'application/javascript' };
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
const asDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});
const unpacking = new Map();
/** Inflate only the assets this worker/backend uses, sharing concurrent requests. Assets sent
 *  as data URLs keep that representation alone, rather than another full byte array too. */
export function assetsReady(names) {
  return Promise.all(names.filter(name => packed().has(name)).map(name => {
    if (!unpacking.has(name)) unpacking.set(name, (async () => {
      const response = await inflateAsset(packedValue(name));
      if (DATA_URLS[name]) dataUrls.set(name, await asDataUrl(new Blob([await response.blob()], { type: DATA_URLS[name] })));
      else decoded.set(name, new Uint8Array(await response.arrayBuffer()));
    })());
    return unpacking.get(name);
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
