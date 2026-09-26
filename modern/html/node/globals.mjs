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

// Node timers are objects whose ref()/unref() say whether they keep the process alive;
// a browser timer is a number, and `setInterval(...).unref()` would throw.
class Timeout {
  constructor(id) { this.id = id; }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
  [Symbol.toPrimitive]() { return this.id; }
}
const timerId = (handle) => handle instanceof Timeout ? handle.id : handle;
const native = { setTimeout: globalThis.setTimeout.bind(globalThis), setInterval: globalThis.setInterval.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
export const setTimeout = (...args) => new Timeout(native.setTimeout(...args));
export const setInterval = (...args) => new Timeout(native.setInterval(...args));
export const clearTimeout = (handle) => native.clearTimeout(timerId(handle));
export const clearInterval = (handle) => native.clearInterval(timerId(handle));
// A message runs next without the 4 ms delay browsers add to nested zero timeouts.
const immediates = new Map(), channel = new MessageChannel();
let nextImmediate = 0;
channel.port1.onmessage = ({ data }) => {
  const task = immediates.get(data);
  if (task) { immediates.delete(data); task(); }
};
export const setImmediate = (callback, ...args) => {
  const id = ++nextImmediate;
  immediates.set(id, () => callback(...args));
  channel.port2.postMessage(id);
  return new Timeout(id);
};
export const clearImmediate = (handle) => { immediates.delete(timerId(handle)); };
export const global = globalThis;
