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
import { asRollbackJournal, installReadOnlyVfs, ReadOnlyDatabase, refusal } from "../html/node/sqlite-vfs.mjs";

const VFS = "program-file";
const key = (filename) => {
  const resolved = path.resolve(String(filename));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
// Mounted path -> { path, offset, size, mtimeMs, fd }: a database inside another file, read at its offset.
const mounts = new Map();
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
  print: () => {}, printErr: () => {} }).then((module) => { sqlite3 = module; installReadOnlyVfs(module, VFS, (name) => mounts.get(name), readInto); })).then(resolve, reject) };

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
  const reason = refusal(sqlite3, key(filename), VFS);
  if (reason) {
    closeSync(mount.fd); mounts.delete(key(filename));
    throw new Error(`${file.name || path.basename(filename)} cannot be used${reason}.`);
  }
}

/** Reads the mount's bytes from `start` into `target`, a WAL database's header as a rollback journal's; the number
 *  read. */
function readInto(mount, target, start) {
  const length = Math.max(0, Math.min(target.length, mount.size - start));
  let done = 0;
  while (done < length) {
    const count = readSync(mount.fd, target, done, length - done, mount.offset + start + done);
    if (!count) break;
    done += count;
  }
  return asRollbackJournal(target, start, done);
}

export class DatabaseSync {
  constructor(filename, ...options) {
    // A constructor's object stands for it: node:sqlite's own, or the in-place reader's.
    return mounts.has(key(filename)) ? new ReadOnlyDatabase(sqlite3, key(filename), VFS) : new NodeDatabase(filename, ...options);
  }
}
export default { DatabaseSync, mountFile, ready };
