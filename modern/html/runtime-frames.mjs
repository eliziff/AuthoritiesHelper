// Runtime messages as one byte frame, for a page whose runtime runs in its desktop program (page-bridge.mjs,
// ../webview/native-runtime.mjs): JSON, with each byte array in it carried as raw bytes after the JSON.
//
//   [u32 JSON length][JSON][u32 count][count x u32 length][the byte arrays, in order]
//
// A byte array stands in the JSON as { "\u0000": index }. Lengths are little-endian.
const MARK = "\u0000";

/** `value` (plain data and byte arrays) as one frame. */
export function encodeFrame(value) {
  const parts = [];
  // The value before its toJSON: a Node Buffer has one.
  const json = new TextEncoder().encode(JSON.stringify(value, function (key, value) {
    const item = this[key];
    if (ArrayBuffer.isView(item)) {
      parts.push(new Uint8Array(item.buffer, item.byteOffset, item.byteLength));
      return { [MARK]: parts.length - 1 };
    }
    if (item instanceof ArrayBuffer) { parts.push(new Uint8Array(item)); return { [MARK]: parts.length - 1 }; }
    if (typeof Blob !== "undefined" && item instanceof Blob)
      throw new Error("A file is given to the desktop runtime as its bytes, not as a file to read.");
    return value;
  }));
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
  return JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length)), (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item) && MARK in item ? parts[item[MARK]] : item);
}
