// node:sqlite for the browser runtime: a read-only DatabaseSync over a file the user picked. SQLite's
// official WebAssembly build reads it through a VFS whose reads are File.slice() calls answered at once
// (FileReaderSync, which Workers have), so a database of any size is read in place, never copied.
// mountFile() names the file by the path Beaver's code opens; the path exists in the runtime's
// filesystem as an empty placeholder that stats as the file (its size and modification time), so
// existsSync and statSync see it as a lookup checking which database it reads expects.
// A program that serves the page may serve a database too: `{ url, size, lastModified }` in place of the
// file, read in place by ranged requests to that address (synchronous ones, which Workers may make).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import wasmBinary from "@sqlite.org/sqlite-wasm/sqlite3.wasm";
import path from "path";
import fs, { volume } from "./fs.mjs";

const VFS = "picked-file";
// Reads go to the file in blocks this large, the most recent kept: a lookup's B-tree pages and a
// document's overflow pages sit near each other.
const BLOCK = 64 * 1024, BLOCKS = 512;
const files = new Map(); // path -> Blob
const open = new Map(); // sqlite3_file pointer -> { blob, blocks }
let sqlite3 = null;

/** Resolves once SQLite is compiled; DatabaseSync needs it. Its WebAssembly is part of the runtime: no
 *  file beside the bundle to locate (the runtime has no import.meta.url to locate one from). */
export const ready = sqlite3InitModule({ wasmBinary, locateFile: (file) => file, print: () => {}, printErr: () => {} })
  .then((module) => { sqlite3 = module; installVfs(module); });

/** Makes `file` (a Blob, or a served file's `{ url, size, lastModified }`) the database at `filename`;
 *  null forgets it. A file that is no database, or one that defines views (which the stores this page reads never
 *  do, and whose queries could run without end), is refused. */
export function mountFile(filename, file) {
  if (!file) { files.delete(filename); fs.rmSync(filename, { force: true }); return; }
  const previous = files.get(filename);
  files.set(filename, file);
  let reason = "";
  try {
    const database = new sqlite3.oo1.DB({ filename, flags: "r", vfs: VFS });
    try { if (database.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'view' LIMIT 1")) reason = ": it defines views"; }
    finally { database.close(); }
  } catch { reason = ": it is not a SQLite database, or it is damaged"; }
  if (reason) {
    if (previous) files.set(filename, previous); else files.delete(filename);
    throw new Error(`${file.name || path.basename(filename)} cannot be used${reason}.`);
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "");
  // memfs (pinned) keeps a file's size and time on its node; nothing reads the placeholder's bytes.
  const node = volume._core.getResolvedLinkOrThrow(filename).getNode();
  node.size = file.size;
  node.mtime = new Date(file.lastModified);
}

// A read that carries on from the last block read reads ahead, twice as far each time it carries on, up to this many
// blocks in one call: a document's overflow pages run on, and each call to the file costs far more than its bytes.
const AHEAD = 16;
function readBlock(entry, index) {
  let block = entry.blocks.get(index);
  if (block) { entry.blocks.delete(index); entry.blocks.set(index, block); return block; }
  entry.run = entry.last === index - 1 ? Math.min((entry.run ?? 1) * 2, AHEAD) : 1;
  const start = index * BLOCK, end = Math.min((index + entry.run) * BLOCK, entry.blob.size);
  const bytes = entry.blob.url ? readServed(entry.blob, start, end)
    : new Uint8Array(new FileReaderSync().readAsArrayBuffer(entry.blob.slice(start, end)));
  const count = Math.max(1, Math.ceil(bytes.length / BLOCK));
  for (let k = 0; k < count; k++) {
    entry.blocks.set(index + k, bytes.subarray(k * BLOCK, (k + 1) * BLOCK));
    if (entry.blocks.size > BLOCKS) entry.blocks.delete(entry.blocks.keys().next().value);
  }
  entry.last = index + count - 1;
  return entry.blocks.get(index);
}

function readServed({ url }, start, end) {
  if (start >= end) return new Uint8Array(0);
  const request = new XMLHttpRequest();
  request.open("GET", url, false);
  request.responseType = "arraybuffer";
  request.setRequestHeader("Range", `bytes=${start}-${end - 1}`);
  request.send();
  if (request.status !== 206) throw new Error(`${url} answered ${request.status} to a ranged read`);
  return new Uint8Array(request.response);
}

function installVfs({ capi, wasm, vfs }) {
  const io = new capi.sqlite3_io_methods();
  io.$iVersion = 1;
  vfs.installVfs({ io: { struct: io, methods: {
    xClose: (pFile) => { open.delete(Number(pFile)); return 0; },
    xRead(pFile, pDest, n, offset64) {
      const entry = open.get(Number(pFile)), start = Number(offset64), heap = wasm.heap8u(), dest = Number(pDest);
      try {
        let done = 0;
        while (done < n) {
          const at = start + done, block = readBlock(entry, Math.floor(at / BLOCK));
          const from = at % BLOCK, count = Math.min(n - done, block.length - from);
          if (count <= 0) break;
          heap.set(block.subarray(from, from + count), dest + done);
          done += count;
        }
        // A WAL database whose log is checkpointed reads as a rollback-journal one: there is no log to
        // read and nothing writes, so SQLite needs no shared memory for it.
        if (start <= 18 && start + done > 19 && heap[dest + 18 - start] === 2) heap[dest + 18 - start] = heap[dest + 19 - start] = 1;
        if (done < n) { heap.fill(0, dest + done, dest + n); return capi.SQLITE_IOERR_SHORT_READ; }
        return 0;
      } catch { return capi.SQLITE_IOERR_READ; }
    },
    xWrite: () => capi.SQLITE_READONLY,
    xTruncate: () => capi.SQLITE_READONLY,
    xSync: () => 0,
    xFileSize: (pFile, pSize) => { wasm.poke64(pSize, BigInt(open.get(Number(pFile)).blob.size)); return 0; },
    xLock: () => 0,
    xUnlock: () => 0,
    xCheckReservedLock: (pFile, pOut) => { wasm.poke32(pOut, 0); return 0; },
    xFileControl: () => capi.SQLITE_NOTFOUND,
    xSectorSize: () => 4096,
    xDeviceCharacteristics: () => capi.SQLITE_IOCAP_IMMUTABLE,
  } } });
  const struct = new capi.sqlite3_vfs(), fallback = new capi.sqlite3_vfs(capi.sqlite3_vfs_find(null));
  struct.$iVersion = 1;
  struct.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  struct.$mxPathname = 1024;
  struct.$xRandomness = fallback.$xRandomness;
  struct.$xSleep = fallback.$xSleep;
  fallback.dispose();
  vfs.installVfs({ vfs: { struct, name: VFS, methods: {
    xOpen(pVfs, zName, pFile, flags, pOutFlags) {
      const blob = zName ? files.get(wasm.cstrToJs(zName)) : null;
      if (!blob) return capi.SQLITE_CANTOPEN;
      open.set(Number(pFile), { blob, blocks: new Map() });
      const file = new capi.sqlite3_file(pFile);
      file.$pMethods = io.pointer;
      file.dispose();
      wasm.poke32(pOutFlags, capi.SQLITE_OPEN_READONLY);
      return 0;
    },
    xDelete: () => capi.SQLITE_IOERR_DELETE,
    xAccess: (pVfs, zName, flags, pOut) => { wasm.poke32(pOut, files.has(wasm.cstrToJs(zName)) ? 1 : 0); return 0; },
    xFullPathname: (pVfs, zName, nOut, pOut) => wasm.cstrncpy(pOut, zName, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN,
    xCurrentTime: (pVfs, pOut) => { wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, "double"); return 0; },
    xCurrentTimeInt64: (pVfs, pOut) => { wasm.poke(pOut, 210866760000000n + BigInt(Date.now()), "i64"); return 0; },
    xGetLastError: () => 0,
  } } });
}

class StatementSync {
  constructor(statement) { this.statement = statement; }
  #rows(parameters, limit) {
    const { statement } = this, rows = [];
    try {
      if (parameters.length) statement.bind(parameters);
      while (rows.length < limit && statement.step()) rows.push(Object.assign(Object.create(null), statement.get({})));
    } finally { statement.reset(true); }
    return rows;
  }
  all(...parameters) { return this.#rows(parameters, Infinity); }
  get(...parameters) { return this.#rows(parameters, 1)[0]; }
  run() { throw new Error("This database is read only."); }
}

export class DatabaseSync {
  #database; #statements = [];
  constructor(filename) {
    if (!sqlite3) throw new Error("SQLite is still loading.");
    if (!files.has(String(filename))) throw new Error(`${filename} is not a file this page was given.`);
    this.#database = new sqlite3.oo1.DB({ filename: String(filename), flags: "r", vfs: VFS });
    // The file's own schema runs no function that is not harmless.
    this.#database.exec("PRAGMA trusted_schema = OFF");
  }
  exec(sql) { this.#database.exec(sql); }
  prepare(sql) {
    const statement = new StatementSync(this.#database.prepare(sql));
    this.#statements.push(statement.statement);
    return statement;
  }
  close() {
    for (const statement of this.#statements.splice(0)) statement.finalize();
    this.#database.close();
  }
}

export default { DatabaseSync, mountFile, ready };
