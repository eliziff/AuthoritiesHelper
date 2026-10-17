// What both in-place readers of a database share (sqlite.mjs in a page's runtime, ../../webview/node-sqlite.mjs in a
// desktop program's): a read-only SQLite VFS over files a lookup names, and a read-only database in node:sqlite's
// shape over it.

/** Makes `name` a VFS that opens what `lookup(path)` gives (anything with a `size`), its bytes read by
 *  `readInto(file, target, start)`, which returns the number read. */
export function installReadOnlyVfs({ capi, wasm, vfs }, name, lookup, readInto) {
  const open = new Map(); // sqlite3_file pointer -> file
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
  vfs.installVfs({ vfs: { struct, name, methods: {
    xOpen(pVfs, zName, pFile, flags, pOutFlags) {
      const found = zName ? lookup(wasm.cstrToJs(zName)) : null;
      if (!found) return capi.SQLITE_CANTOPEN;
      open.set(Number(pFile), found);
      const file = new capi.sqlite3_file(pFile);
      file.$pMethods = io.pointer;
      file.dispose();
      wasm.poke32(pOutFlags, capi.SQLITE_OPEN_READONLY);
      return 0;
    },
    xDelete: () => capi.SQLITE_IOERR_DELETE,
    xAccess: (pVfs, zName, flags, pOut) => { wasm.poke32(pOut, lookup(wasm.cstrToJs(zName)) ? 1 : 0); return 0; },
    xFullPathname: (pVfs, zName, nOut, pOut) => wasm.cstrncpy(pOut, zName, nOut) < nOut ? 0 : capi.SQLITE_CANTOPEN,
    xCurrentTime: (pVfs, pOut) => { wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, "double"); return 0; },
    xCurrentTimeInt64: (pVfs, pOut) => { wasm.poke(pOut, 210866760000000n + BigInt(Date.now()), "i64"); return 0; },
    xGetLastError: () => 0,
  } } });
}

/** `done` bytes read from `start` into `target`, a WAL database's header as a rollback journal's (a WAL database whose
 *  log is checkpointed reads as a rollback-journal one: there is no log to read and nothing writes, so SQLite needs no
 *  shared memory for it); `done`. */
export function asRollbackJournal(target, start, done) {
  if (start <= 18 && start + done > 19 && target[18 - start] === 2) target[18 - start] = target[19 - start] = 1;
  return done;
}

/** Why the database at `filename` cannot be used, or "": one that is no database, or one that defines views (which the
 *  stores read here never do, and whose queries could run without end), is refused. */
export function refusal(sqlite3, filename, vfs) {
  try {
    const database = new sqlite3.oo1.DB({ filename, flags: "r", vfs });
    try { return database.selectValue("SELECT 1 FROM sqlite_master WHERE type = 'view' LIMIT 1") ? ": it defines views" : ""; }
    finally { database.close(); }
  } catch { return ": it is not a SQLite database, or it is damaged"; }
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

/** A database read in place through `vfs`: what Beaver's store lookups ask of node:sqlite. */
export class ReadOnlyDatabase {
  #database; #statements = [];
  constructor(sqlite3, filename, vfs) {
    this.#database = new sqlite3.oo1.DB({ filename, flags: "r", vfs });
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
