// node:sqlite for a desktop program's runtime (native-runtime.mjs), with the local stores its page names: a database
// the program serves (`{ url, size, lastModified }`), such as one carried inside its executable, is read where it
// lies, at its offset, by SQLite's WebAssembly build over a read-only VFS, never copied. mountFile() gives it the path
// Beaver's code opens, and node-fs.mjs lets that code see the path as the file (its size and modification time).
// Every other path is node:sqlite's own.
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { DatabaseSync as NodeDatabase } from "node:sqlite";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import wasmBinary from "@sqlite.org/sqlite-wasm/sqlite3.wasm";

const VFS = "program-file";
const key = (filename) => {
  const resolved = path.resolve(String(filename));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
// Mounted path -> { path, offset, size, mtimeMs, fd }: a database inside another file, read at its offset.
const mounts = new Map();
const open = new Map(); // sqlite3_file pointer -> mount
let served = () => null, sqlite3 = null, loading = null;

/** How the program finds a file it serves: `resolve(url)` is `{ path, offset, size, mtimeMs }`, or null. */
export const useServedFiles = (resolve) => { served = resolve; };
/** Where a file the page names lies: its path, and its offset there (0 for a file of its own). */
export function servedFile(file) {
  const place = typeof file?.url === "string" ? served(file.url) : null;
  if (!place) throw new Error(`${file?.name ?? "That file"} is not a file this program serves.`);
  return place;
}
/** The database mounted at `filename`, as a file: its size and modification time. */
export const mountedFile = (filename) => mounts.get(key(filename)) ?? null;

/** Resolves once SQLite's WebAssembly build is ready; only a database read in place needs it, and it loads then. */
export const ready = { then: (resolve, reject) => (loading ??= sqlite3InitModule({ wasmBinary, locateFile: (file) => file,
  print: () => {}, printErr: () => {} }).then((module) => { sqlite3 = module; installVfs(module); })).then(resolve, reject) };

/** Makes the file the program serves (`file`) the database at `filename`, read in place; null forgets it. A
 *  database that defines views (which these stores never do, and whose queries could run without end) is refused. */
export function mountFile(filename, file) {
  const previous = mounts.get(key(filename));
  if (previous) { closeSync(previous.fd); mounts.delete(key(filename)); }
  if (!file) return;
  if (!sqlite3) throw new Error("SQLite is still loading.");
  const place = servedFile(file);
  const mount = { ...place, fd: openSync(place.path, "r") };
  mounts.set(key(filename), mount);
  let reason = "";
  try {
    const database = new sqlite3.oo1.DB({ filename: key(filename), flags: "r", vfs: VFS });
    try { if (database.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'view' LIMIT 1")) reason = ": it defines views"; }
    finally { database.close(); }
  } catch { reason = ": it is not a SQLite database, or it is damaged"; }
  if (reason) {
    closeSync(mount.fd); mounts.delete(key(filename));
    throw new Error(`${file.name || path.basename(filename)} cannot be used${reason}.`);
  }
}

/** Reads the mount's bytes from `start` into `target`, a WAL database's header as a rollback journal's (a WAL database
 *  whose log is checkpointed reads as a rollback-journal one: there is no log to read and nothing writes, so SQLite
 *  needs no shared memory for it); the number read. */
function readInto(mount, target, start) {
  const length = Math.max(0, Math.min(target.length, mount.size - start));
  let done = 0;
  while (done < length) {
    const count = readSync(mount.fd, target, done, length - done, mount.offset + start + done);
    if (!count) break;
    done += count;
  }
  if (start <= 18 && start + done > 19 && target[18 - start] === 2) target[18 - start] = target[19 - start] = 1;
  return done;
}

function installVfs({ capi, wasm, vfs }) {
  const io = new capi.sqlite3_io_methods();
  io.$iVersion = 1;
  vfs.installVfs({ io: { struct: io, methods: {
    xClose: (pFile) => { open.delete(Number(pFile)); return 0; },
    xRead(pFile, pDest, n, offset64) {
      const target = wasm.heap8u().subarray(Number(pDest), Number(pDest) + n);
      try {
        const done = readInto(open.get(Number(pFile)), target, Number(offset64));
        if (done < n) { target.fill(0, done); return capi.SQLITE_IOERR_SHORT_READ; }
        return 0;
      } catch { return capi.SQLITE_IOERR_READ; }
    },
    xWrite: () => capi.SQLITE_READONLY,
    xTruncate: () => capi.SQLITE_READONLY,
    xSync: () => 0,
    xFileSize: (pFile, pSize) => { wasm.poke64(pSize, BigInt(open.get(Number(pFile)).size)); return 0; },
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
      const mount = zName ? mounts.get(wasm.cstrToJs(zName)) : null;
      if (!mount) return capi.SQLITE_CANTOPEN;
      open.set(Number(pFile), mount);
      const file = new capi.sqlite3_file(pFile);
      file.$pMethods = io.pointer;
      file.dispose();
      wasm.poke32(pOutFlags, capi.SQLITE_OPEN_READONLY);
      return 0;
    },
    xDelete: () => capi.SQLITE_IOERR_DELETE,
    xAccess: (pVfs, zName, flags, pOut) => { wasm.poke32(pOut, mounts.has(wasm.cstrToJs(zName)) ? 1 : 0); return 0; },
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

/** A database read in place: what Beaver's store lookups ask of node:sqlite. */
class InPlaceDatabase {
  #database; #statements = [];
  constructor(filename) {
    if (!sqlite3) throw new Error("SQLite is still loading.");
    this.#database = new sqlite3.oo1.DB({ filename, flags: "r", vfs: VFS });
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

export class DatabaseSync {
  constructor(filename, ...options) {
    // A constructor's object stands for it: node:sqlite's own, or the in-place reader's.
    return mounts.has(key(filename)) ? new InPlaceDatabase(key(filename)) : new NodeDatabase(filename, ...options);
  }
}
export default { DatabaseSync, mountFile, ready };
