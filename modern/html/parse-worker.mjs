// Parses one PDF at a time beside the runtime, on its own instance of the engine and its own
// memory filesystem, so a long parse never holds up the runtime and several run at once.
// A job brings the parse cache the runtime already holds for its source and takes back the
// cache files the parse wrote; the runtime's engine then reads the document from them.
import { Volume, createFsFromVolume } from "memfs";
import { createStructureAddon, warmStructureAddon } from "./structure-addon.mjs";
import { createWasi } from "./wasi.mjs";

const volume = new Volume(), fs = createFsFromVolume(volume);
let engine, addon, memory;

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).flatMap((name) => {
    const path = `${directory}/${name}`;
    return fs.statSync(path).isDirectory() ? files(path) : [path];
  });
}

self.onmessage = async ({ data: { id, module, bytes, request, cache } }) => {
  if (module) {
    // The engine is here: the runtime's thread, which delivers it, is free for its own work.
    self.postMessage({ started: true });
    engine = module;
    addon = createStructureAddon(() => {
      let stderr = "";
      const wasi = createWasi(fs, { stderr: (text) => { stderr = `${stderr}\n${text}`.slice(-4_000); },
        env: { LEGALPDF_CACHE_MAX_BYTES: String(Number.MAX_SAFE_INTEGER) } });
      const instance = new WebAssembly.Instance(engine, wasi.imports);
      wasi.initialize(instance);
      memory = instance.exports.memory;
      return { instance, close: wasi.close,
        panic: () => stderr.split(/panicked at [^\n]*\n/u).at(-1).trim().split("\n")[0] ?? "" };
    });
    warmStructureAddon(addon);
    return;
  }
  volume.reset();
  fs.mkdirSync("/tmp", { recursive: true });
  const given = new Map(cache.map(([path, content]) => [path, content.byteLength]));
  for (const [path, content] of cache) {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, content);
  }
  try {
    const summary = await addon.preparePdfDocument(bytes, request);
    const written = files(request.cache_dir).filter((path) => given.get(path) !== fs.statSync(path).size)
      .map((path) => [path, new Uint8Array(fs.readFileSync(path))]);
    volume.reset();
    // The engine's memory, which never shrinks, tells the pool when to start this parser afresh.
    self.postMessage({ id, summary, files: written, memory: memory.buffer.byteLength },
      written.map(([, content]) => content.buffer));
  } catch (error) {
    volume.reset();
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
