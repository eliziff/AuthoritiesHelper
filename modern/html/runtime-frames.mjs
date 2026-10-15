// Runtime messages as one byte frame, for a page whose runtime runs in its desktop program (page-bridge.mjs,
// ../webview/native-runtime.mjs): JSON, with each byte array in it carried as raw bytes after the JSON.
//
//   [u32 JSON length][JSON][u32 count][count x u32 length][the byte arrays, in order]
//
// A byte array stands in the JSON as { "\u0000": index }. Lengths are little-endian. The value is walked once each way,
// copying only the objects that hold bytes: JSON's own replacer and reviver call back for every value, which costs more
// than the copy for a draft's hundreds of kilobytes.
const MARK = "\u0000";

/** `value`, its byte arrays (`parts`) replaced by their marks; the same object where it holds none. */
function marked(value, parts) {
  if (!value || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    parts.push(value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return { [MARK]: parts.length - 1 };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob)
    throw new Error("A file is given to the desktop runtime as its bytes, not as a file to read.");
  let copy = null;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, item] of entries) {
    const replaced = marked(item, parts);
    if (replaced !== item) (copy ??= Array.isArray(value) ? [...value] : { ...value })[key] = replaced;
  }
  return copy ?? value;
}

/** `value` (plain data and byte arrays) as one frame. */
export function encodeFrame(value) {
  const parts = [];
  const json = new TextEncoder().encode(JSON.stringify(marked(value, parts)));
  const head = 8 + json.length + 4 * parts.length;
  const frame = new Uint8Array(head + parts.reduce((sum, part) => sum + part.length, 0));
  const view = new DataView(frame.buffer);
  view.setUint32(0, json.length, true);
  frame.set(json, 4);
  view.setUint32(4 + json.length, parts.length, true);
  let at = head;
  parts.forEach((part, index) => {
    view.setUint32(8 + json.length + 4 * index, part.length, true);
    frame.set(part, at); at += part.length;
  });
  return frame;
}

/** `value` with each mark replaced by its byte array, in place. */
function unmarked(value, parts) {
  if (!value || typeof value !== "object") return value;
  if (!Array.isArray(value) && MARK in value) return parts[value[MARK]];
  for (const key in value) value[key] = unmarked(value[key], parts);
  return value;
}

/** The value a frame carries; each byte array is `bytes(frame, offset, length)`, by default a copy of its own. */
export function decodeFrame(frame, bytes = (source, offset, length) => source.slice(offset, offset + length)) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.getUint32(0, true), count = view.getUint32(4 + length, true);
  const parts = [];
  let at = 8 + length + 4 * count;
  for (let index = 0; index < count; index++) {
    const size = view.getUint32(8 + length + 4 * index, true);
    if (at + size > frame.length) throw new Error("A runtime message was cut short.");
    parts.push(bytes(frame, at, size)); at += size;
  }
  const value = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length)));
  return count ? unmarked(value, parts) : value;
}
