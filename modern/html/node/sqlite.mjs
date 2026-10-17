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
import { asRollbackJournal, installReadOnlyVfs, ReadOnlyDatabase, refusal } from "./sqlite-vfs.mjs";

const VFS = "picked-file";
// Reads go to the file in blocks this large, the most recent kept: a lookup's B-tree pages and a
// document's overflow pages sit near each other.
const BLOCK = 64 * 1024, BLOCKS = 512;
const files = new Map(); // path -> Blob or served file
// A file's blocks outlive the connection that read them: each lookup opens the database afresh, and every one reads
// its B-tree's root and inner pages again. A file chosen anew is another Blob, with blocks of its own.
const read = new WeakMap(); // Blob or served file -> { blob, blocks }
let sqlite3 = null;

/** Resolves once SQLite is compiled; DatabaseSync needs it. Its WebAssembly is part of the runtime: no
 *  file beside the bundle to locate (the runtime has no import.meta.url to locate one from). */
export const ready = sqlite3InitModule({ wasmBinary, locateFile: (file) => file, print: () => {}, printErr: () => {} })
  .then((module) => { sqlite3 = module; installReadOnlyVfs(module, VFS, (name) => files.get(name), readInto); });

/** Makes `file` (a Blob, or a served file's `{ url, size, lastModified }`) the database at `filename`;
 *  null forgets it. A file that is no database, or one that defines views (which the stores this page reads never
 *  do, and whose queries could run without end), is refused. */
export function mountFile(filename, file) {
  if (!file) { files.delete(filename); fs.rmSync(filename, { force: true }); return; }
  const previous = files.get(filename);
  files.set(filename, file);
  const reason = refusal(sqlite3, filename, VFS);
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

/** Reads `file`'s bytes from `start` into `target`, a WAL database's header as a rollback journal's; the number read. */
function readInto(file, target, start) {
  if (!read.has(file)) read.set(file, { blob: file, blocks: new Map() });
  const entry = read.get(file);
  let done = 0;
  while (done < target.length && start + done < file.size) {
    const at = start + done, block = readBlock(entry, Math.floor(at / BLOCK));
    const from = at % BLOCK, count = Math.min(target.length - done, block.length - from);
    if (count <= 0) break;
    target.set(block.subarray(from, from + count), done);
    done += count;
  }
  return asRollbackJournal(target, start, done);
}

/** The files mounted here, as the engine's WASI filesystem reads them: the legal-structure engine reads the A2AJ
 *  store itself. */
export const mounted = {
  size: (filename) => files.get(filename)?.size,
  read: (filename, target, position) => readInto(files.get(filename), target, position),
};

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

export class DatabaseSync extends ReadOnlyDatabase {
  constructor(filename) {
    if (!sqlite3) throw new Error("SQLite is still loading.");
    if (!files.has(String(filename))) throw new Error(`${filename} is not a file this page was given.`);
    super(sqlite3, String(filename), VFS);
  }
}

export default { DatabaseSync, mountFile, mounted, ready };
