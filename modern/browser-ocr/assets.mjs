const urls = new Map();
export function bytes(name) {
  const value = globalThis.AUTHORITIES_ASSETS?.[name];
  if (!value) throw new Error(`The packaged runtime is missing ${name}.`);
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
export function assetURL(name, mime = 'application/javascript') {
  // Match Legal Browser OCR: a file-origin child worker cannot import sibling blob:null modules.
  if (['ortMjs','ortWasm','layoutCore','layoutWasm'].includes(name)) {
    const data = globalThis.AUTHORITIES_ASSETS?.[name];
    if (!data) throw new Error(`The packaged runtime is missing ${name}.`);
    return `data:${mime};base64,${data}`;
  }
  if (!urls.has(name)) urls.set(name, URL.createObjectURL(new Blob([bytes(name)], { type: mime })));
  return urls.get(name);
}
export function textAsset(name) { return new TextDecoder().decode(bytes(name)); }
