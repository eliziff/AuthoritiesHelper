// Private data appended to the finished executable, unpacked once per content hash.
// Port of ALR-Quote-Verifier verifier_core/overlay_store.py (the PyInstaller cookie is not
// needed: a Node single executable finds its program in a PE resource, not by a tail search).
//
//   [node.exe with the app's SEA blob][entry bytes...][footer JSON][u64 LE footer length][MAGIC]
//
// Each entry unpacks to <dataDir>/<stem>-<sha12><ext>; a later build with other content unpacks
// beside it and sweeps the old copy.
import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("ALRVOVL1");
// An Authenticode signature, if one is added later, follows the overlay.
const TAIL_SEARCH = 1024 * 1024;

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename, { highWaterMark: 16 << 20 })) hash.update(chunk);
  return hash.digest("hex");
}

/** Appends `entries` ([{ name, file }]) to `exe`. */
export async function appendOverlay(exe, entries) {
  let offset = statSync(exe).size;
  const footer = { version: 1, entries: [] };
  for (const { name, file } of entries) {
    const size = statSync(file).size;
    footer.entries.push({ name, offset, size, sha256: await sha256File(file) });
    offset += size;
  }
  for (const [index, { file }] of entries.entries()) {
    const out = createWriteStream(exe, { flags: "a" });
    await pipeline(createReadStream(file, { highWaterMark: 16 << 20 }), out);
    if (statSync(exe).size !== footer.entries[index].offset + footer.entries[index].size)
      throw new Error(`Overlay entry ${footer.entries[index].name} was not appended whole`);
  }
  const json = Buffer.from(JSON.stringify(footer));
  const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(json.length));
  const out = createWriteStream(exe, { flags: "a" });
  await pipeline(async function* () { yield json; yield length; yield MAGIC; }, out);
  return footer.entries;
}

/** The overlay footer of `exe`, or null when it carries none. */
export function readOverlay(exe) {
  const fd = openSync(exe, "r");
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - TAIL_SEARCH);
    const tail = Buffer.alloc(size - start); readSync(fd, tail, 0, tail.length, start);
    for (let marker = tail.lastIndexOf(MAGIC); marker >= 8; marker = tail.lastIndexOf(MAGIC, marker - 1)) {
      const length = Number(tail.readBigUInt64LE(marker - 8)), footerStart = start + marker - 8 - length;
      if (length <= 0 || footerStart < 0) continue;
      const json = Buffer.alloc(length); readSync(fd, json, 0, length, footerStart);
      try {
        const footer = JSON.parse(json.toString("utf8"));
        if (footer?.version === 1 && Array.isArray(footer.entries) && footer.entries.every((entry) =>
          Number.isSafeInteger(entry.offset) && Number.isSafeInteger(entry.size) && entry.offset >= 0 &&
          entry.offset + entry.size <= footerStart && /^[a-f0-9]{64}$/u.test(entry.sha256))) return footer;
      } catch { /* not this marker */ }
    }
    return null;
  } finally { closeSync(fd); }
}

export function overlayTarget(dataDir, entry) {
  const ext = path.extname(entry.name), stem = entry.name.slice(0, entry.name.length - ext.length);
  return path.join(dataDir, `${stem}-${entry.sha256.slice(0, 12)}${ext}`);
}

/** Unpacks every entry not yet unpacked; returns { name: path }. `progress(name, done, total)`. */
export function unpackOverlay(exe, footer, dataDir, progress) {
  mkdirSync(dataDir, { recursive: true });
  const paths = {};
  for (const entry of footer.entries) {
    const target = overlayTarget(dataDir, entry);
    paths[entry.name] = target;
    if (existsSync(target) && statSync(target).size === entry.size) continue;
    const temporary = `${target}.tmp${process.pid}`, chunk = Buffer.alloc(16 << 20);
    const source = openSync(exe, "r"), destination = openSync(temporary, "w");
    try {
      for (let done = 0; done < entry.size;) {
        const read = readSync(source, chunk, 0, Math.min(chunk.length, entry.size - done), entry.offset + done);
        if (!read) throw new Error(`The program file ends inside ${entry.name}`);
        for (let written = 0; written < read;) written += writeSync(destination, chunk, written, read - written);
        done += read; progress?.(entry.name, done, entry.size);
      }
    } finally { closeSync(source); closeSync(destination); }
    renameSync(temporary, target);
    const ext = path.extname(entry.name), stem = entry.name.slice(0, entry.name.length - ext.length);
    for (const old of readdirSync(dataDir)) {
      const candidate = path.join(dataDir, old);
      if (candidate !== target && old.startsWith(`${stem}-`) && (old.endsWith(ext) || old.includes(`${ext}.tmp`)))
        try { unlinkSync(candidate); } catch { /* in use by another copy of the app */ }
    }
  }
  return paths;
}
