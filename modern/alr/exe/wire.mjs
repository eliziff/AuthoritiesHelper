// Operation inputs and results between the page and the program: JSON, with each byte array carried
// as { "$bytes": base64 }. Shared by both ends (server.mjs, page-client.mjs).
const toBase64 = (bytes) => {
  if (typeof Buffer === "function") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    text += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  return btoa(text);
};
const fromBase64 = (text) => typeof Buffer === "function" ? new Uint8Array(Buffer.from(text, "base64"))
  : Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

export const encodeWire = (value) => JSON.stringify(value, function (key, item) {
  const raw = this[key];
  if (raw instanceof Uint8Array) return { $bytes: toBase64(raw) };
  if (raw instanceof ArrayBuffer) return { $bytes: toBase64(new Uint8Array(raw)) };
  return item;
});
export const decodeWire = (text) => JSON.parse(text, (_key, item) =>
  item && typeof item === "object" && typeof item.$bytes === "string" && Object.keys(item).length === 1
    ? fromBase64(item.$bytes) : item);
