// WASI preview1 for the legal-structure engine, over the runtime's shared
// in-memory filesystem. The engine and the TypeScript runtime therefore read
// and write the same files (PDF projection caches, journal inputs).
// Only the calls the engine imports are implemented.

const ERRNO = { SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31,
  NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55 };
const CODES = { ENOENT: ERRNO.NOENT, EEXIST: ERRNO.EXIST, EISDIR: ERRNO.ISDIR, ENOTDIR: ERRNO.NOTDIR,
  ENOTEMPTY: ERRNO.NOTEMPTY, EACCES: ERRNO.ACCES, EPERM: ERRNO.ACCES, EBADF: ERRNO.BADF, EINVAL: ERRNO.INVAL };
const FILETYPE = { CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
const FDFLAGS_APPEND = 1;
const RIGHT_FD_WRITE = 1n << 6n;

class WasiExit extends Error {
  constructor(code) { super(`WASI exit ${code}`); this.code = code; }
}

/** @param {import("node:fs")} fs a synchronous Node-style filesystem (memfs) */
export function createWasi(fs, { stdout = console.log, stderr = console.error } = {}) {
  let memory;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  const text = (pointer, length) => decoder.decode(bytes().subarray(pointer, pointer + length));
  const fds = new Map([
    [0, { kind: "stdio" }], [1, { kind: "stdio", write: stdout }], [2, { kind: "stdio", write: stderr }],
    [3, { kind: "dir", path: "/", preopen: "/" }],
  ]);
  let nextFd = 4;
  const resolve = (fd, pointer, length) => {
    const base = fds.get(fd);
    if (base?.kind !== "dir") return null;
    const relative = text(pointer, length);
    const joined = relative.startsWith("/") ? relative : `${base.path.replace(/\/$/, "")}/${relative}`;
    const parts = [];
    for (const part of joined.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop(); else parts.push(part);
    }
    return `/${parts.join("/")}`;
  };
  const errno = (error) => CODES[error?.code] ?? ERRNO.IO;
  const guard = (operation) => {
    try { return operation() ?? ERRNO.SUCCESS; }
    catch (error) { if (error instanceof WasiExit) throw error; return errno(error); }
  };
  const iovecs = (pointer, count) => Array.from({ length: count }, (_, index) => ({
    buffer: view().getUint32(pointer + index * 8, true), length: view().getUint32(pointer + index * 8 + 4, true),
  }));
  const writeFilestat = (pointer, stat) => {
    const out = view();
    out.setBigUint64(pointer, 0n, true);
    out.setBigUint64(pointer + 8, BigInt(stat.ino ?? 0), true);
    out.setUint8(pointer + 16, stat.isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
    out.setBigUint64(pointer + 24, BigInt(stat.nlink ?? 1), true);
    out.setBigUint64(pointer + 32, BigInt(stat.size), true);
    for (const [offset, time] of [[40, stat.atimeMs], [48, stat.mtimeMs], [56, stat.ctimeMs]])
      out.setBigUint64(pointer + offset, BigInt(Math.round((time ?? 0) * 1e6)), true);
  };

  const imports = {
    args_get: () => ERRNO.SUCCESS,
    args_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
    environ_get: () => ERRNO.SUCCESS,
    environ_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
    clock_time_get: (_id, _precision, pointer) => {
      view().setBigUint64(pointer, BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)), true);
      return ERRNO.SUCCESS;
    },
    random_get: (pointer, length) => {
      for (let offset = 0; offset < length; offset += 65_536)
        crypto.getRandomValues(bytes().subarray(pointer + offset, pointer + Math.min(length, offset + 65_536)));
      return ERRNO.SUCCESS;
    },
    proc_exit: (code) => { throw new WasiExit(code); },
    sched_yield: () => ERRNO.SUCCESS,
    fd_prestat_get: (fd, pointer) => {
      const entry = fds.get(fd);
      if (!entry?.preopen) return ERRNO.BADF;
      view().setUint8(pointer, 0); view().setUint32(pointer + 4, encoder.encode(entry.preopen).length, true);
      return ERRNO.SUCCESS;
    },
    fd_prestat_dir_name: (fd, pointer, length) => {
      const entry = fds.get(fd);
      if (!entry?.preopen) return ERRNO.BADF;
      bytes().set(encoder.encode(entry.preopen).subarray(0, length), pointer);
      return ERRNO.SUCCESS;
    },
    fd_fdstat_get: (fd, pointer) => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO.BADF;
      const out = view();
      out.setUint8(pointer, entry.kind === "dir" ? FILETYPE.DIRECTORY
        : entry.kind === "file" ? FILETYPE.REGULAR_FILE : FILETYPE.CHARACTER_DEVICE);
      out.setUint16(pointer + 2, entry.append ? FDFLAGS_APPEND : 0, true);
      out.setBigUint64(pointer + 8, 0xffffffffffffffffn, true);
      out.setBigUint64(pointer + 16, 0xffffffffffffffffn, true);
      return ERRNO.SUCCESS;
    },
    fd_filestat_set_times: (fd) => fds.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF,
    fd_sync: (fd) => fds.has(fd) ? ERRNO.SUCCESS : ERRNO.BADF,
    fd_close: (fd) => guard(() => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO.BADF;
      if (entry.kind === "file") fs.closeSync(entry.handle);
      fds.delete(fd);
    }),
    fd_read: (fd, pointer, count, readPointer) => guard(() => {
      const entry = fds.get(fd);
      if (entry?.kind !== "file") return entry ? ERRNO.BADF : ERRNO.BADF;
      let total = 0;
      for (const { buffer, length } of iovecs(pointer, count)) {
        const read = fs.readSync(entry.handle, bytes(), buffer, length, entry.position);
        entry.position += read; total += read;
        if (read < length) break;
      }
      view().setUint32(readPointer, total, true);
    }),
    fd_write: (fd, pointer, count, writtenPointer) => guard(() => {
      const entry = fds.get(fd);
      if (!entry) return ERRNO.BADF;
      let total = 0;
      for (const { buffer, length } of iovecs(pointer, count)) {
        const chunk = bytes().slice(buffer, buffer + length);
        if (entry.kind === "stdio") { entry.write?.(decoder.decode(chunk).replace(/\n$/, "")); total += length; continue; }
        if (entry.kind !== "file") return ERRNO.BADF;
        if (entry.append) entry.position = fs.fstatSync(entry.handle).size;
        const written = fs.writeSync(entry.handle, chunk, 0, length, entry.position);
        entry.position += written; total += written;
      }
      view().setUint32(writtenPointer, total, true);
    }),
    fd_readdir: (fd, pointer, length, cookie, usedPointer) => guard(() => {
      const entry = fds.get(fd);
      if (entry?.kind !== "dir") return ERRNO.NOTDIR;
      const names = fs.readdirSync(entry.path, { withFileTypes: true });
      let used = 0;
      for (let index = Number(cookie); index < names.length && used < length; index += 1) {
        const name = encoder.encode(names[index].name);
        const record = new Uint8Array(24 + name.length), out = new DataView(record.buffer);
        out.setBigUint64(0, BigInt(index + 1), true);
        out.setBigUint64(8, 0n, true);
        out.setUint32(16, name.length, true);
        out.setUint8(20, names[index].isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
        record.set(name, 24);
        const take = Math.min(record.length, length - used);
        bytes().set(record.subarray(0, take), pointer + used);
        used += take;
      }
      view().setUint32(usedPointer, used, true);
    }),
    path_filestat_get: (fd, _flags, pointer, length, statPointer) => guard(() => {
      const target = resolve(fd, pointer, length);
      if (!target) return ERRNO.BADF;
      writeFilestat(statPointer, fs.statSync(target));
    }),
    path_create_directory: (fd, pointer, length) => guard(() => {
      const target = resolve(fd, pointer, length);
      if (!target) return ERRNO.BADF;
      fs.mkdirSync(target);
    }),
    path_rename: (fd, oldPointer, oldLength, newFd, newPointer, newLength) => guard(() => {
      const from = resolve(fd, oldPointer, oldLength), to = resolve(newFd, newPointer, newLength);
      if (!from || !to) return ERRNO.BADF;
      fs.renameSync(from, to);
    }),
    path_unlink_file: (fd, pointer, length) => guard(() => {
      const target = resolve(fd, pointer, length);
      if (!target) return ERRNO.BADF;
      fs.unlinkSync(target);
    }),
    path_open: (fd, _dirflags, pointer, length, oflags, rightsBase, _inheriting, fdflags, openedPointer) => guard(() => {
      const target = resolve(fd, pointer, length);
      if (!target) return ERRNO.BADF;
      let stat = null;
      try { stat = fs.statSync(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (stat?.isDirectory() || oflags & OFLAGS.DIRECTORY) {
        if (!stat) return ERRNO.NOENT;
        if (!stat.isDirectory()) return ERRNO.NOTDIR;
        fds.set(nextFd, { kind: "dir", path: target });
      } else {
        const write = (BigInt(rightsBase) & RIGHT_FD_WRITE) !== 0n;
        if (oflags & OFLAGS.EXCL && oflags & OFLAGS.CREAT && stat) return ERRNO.EXIST;
        if (!stat && !(oflags & OFLAGS.CREAT)) return ERRNO.NOENT;
        const flags = write ? (oflags & OFLAGS.TRUNC || !stat ? "w+" : "r+") : "r";
        const handle = fs.openSync(target, flags);
        fds.set(nextFd, { kind: "file", handle, position: 0, append: !!(fdflags & FDFLAGS_APPEND) });
      }
      view().setUint32(openedPointer, nextFd, true);
      nextFd += 1;
    }),
  };
  return {
    imports: { wasi_snapshot_preview1: imports },
    /** Bind the instance's memory; the engine is a reactor with no start function. */
    initialize(instance) { memory = instance.exports.memory; instance.exports._initialize?.(); },
  };
}
