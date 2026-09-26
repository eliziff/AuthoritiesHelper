// Globals Node code expects, injected into the runtime bundle.
import { Buffer } from "buffer";
import EventEmitter from "events";

export { Buffer };
export const ENGINE_PATH = "/engine/legal_structure_node.wasm";

const events = new EventEmitter();
export const process = Object.assign(events, {
  env: { NODE_ENV: "production", LEGAL_STRUCTURE_NATIVE: ENGINE_PATH },
  platform: "linux",
  arch: "wasm32",
  version: "v22.0.0",
  versions: { node: "22.0.0" },
  argv: [],
  pid: 1,
  browser: true,
  cwd: () => "/",
  exit: () => { throw new Error("process.exit is unavailable"); },
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  emitWarning: () => {},
  hrtime: Object.assign((previous) => {
    const now = BigInt(Math.round(performance.now() * 1e6));
    const value = previous ? now - (BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1])) : now;
    return [Number(value / 1_000_000_000n), Number(value % 1_000_000_000n)];
  }, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  // Assigned by the runtime once its filesystem exists (runtime-worker.mjs).
  dlopen() { throw new Error("The Authorities engine is not loaded yet."); },
});

export const setImmediate = (callback, ...args) => setTimeout(callback, 0, ...args);
export const clearImmediate = (handle) => clearTimeout(handle);
export const global = globalThis;
