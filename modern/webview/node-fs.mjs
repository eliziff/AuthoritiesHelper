// node:fs for the store lookups of a desktop program's runtime: a database node-sqlite.mjs reads in place exists at
// the path it is mounted at, and stats as its file (its size and modification time), as the lookups check.
import fs from "node:fs";
import { mountedFile } from "./node-sqlite.mjs";

export * from "node:fs";

export function existsSync(filename) {
  return !!mountedFile(filename) || fs.existsSync(filename);
}

export function statSync(filename, options) {
  const mounted = mountedFile(filename);
  if (!mounted) return fs.statSync(filename, options);
  const time = new Date(mounted.mtimeMs);
  return Object.assign(Object.create(fs.Stats.prototype), { size: mounted.size, mtimeMs: mounted.mtimeMs, mtime: time,
    ctimeMs: mounted.mtimeMs, ctime: time, birthtimeMs: mounted.mtimeMs, birthtime: time,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false });
}

export default { ...fs, existsSync, statSync };
