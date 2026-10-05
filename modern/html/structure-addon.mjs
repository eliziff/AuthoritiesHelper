// The legal-structure engine for the page: the same crate as the Node addon, compiled to
// WebAssembly (native/legal-structure-node, wasm32-wasip1), called through the same dispatch.
import { structureEngineAddon } from "../../../shared/structure-engine.mjs";

export { SIGNATURES, warmStructureAddon } from "../../../shared/structure-engine.mjs";

/**
 * @param {() => { instance: WebAssembly.Instance, panic: () => string, close?: () => void }} instantiate
 *   a fresh WASI-initialized engine and the panic text it last wrote to stderr
 * @param {(bytes: Uint8Array) => Uint8Array} toBuffer wraps result bytes as the host's Buffer
 * @param recognizePdf the host's recognizer of scanned pages
 * @param {{ prepare(bytes, request, signal): Promise<object>, seed(sha256): Promise<void> }} [parser]
 *   prepares PDFs elsewhere, writing the parse cache where this engine reads it
 */
export function createStructureAddon(instantiate, toBuffer, recognizePdf, parser) {
  // A Rust panic traps the instance and leaves its memory unusable; the next call starts a new one.
  let engine = null;
  return structureEngineAddon({
    call(request) {
      const wasm = (engine ??= instantiate()).instance.exports;
      const input = wasm.authorities_alloc(request.length);
      new Uint8Array(wasm.memory.buffer, input, request.length).set(request);
      const output = wasm.authorities_call(input, request.length);
      wasm.authorities_free(input, request.length);
      const size = new DataView(wasm.memory.buffer, output, 4).getUint32(0, true);
      const reply = new Uint8Array(wasm.memory.buffer, output + 4, size).slice();
      wasm.authorities_free(output, size + 4);
      return reply;
    },
    memoryBytes: () => engine?.instance.exports.memory.buffer.byteLength ?? 0,
    restart() {
      const dropped = engine;
      engine = null;
      dropped?.close?.();
      return dropped?.panic() ?? "";
    },
  }, { toBuffer, recognizePdf, parser });
}
