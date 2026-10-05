// The runtime's one filesystem: Node's fs API over memory, shared with the engine's WASI.
import { Volume, createFsFromVolume } from "memfs";

export const volume = new Volume();
const fs = createFsFromVolume(volume);
for (const directory of ["/tmp", "/home/authorities"]) fs.mkdirSync(directory, { recursive: true });

// memfs keeps a file's bytes when rm removes it or rename replaces it: its inode stays in the volume
// though no name reaches it. Both go through unlink, which gives the inode back.
const { rmSync: removeEntry, renameSync: moveEntry } = fs;
const remove = (path) => {
  if (!fs.lstatSync(path).isDirectory()) return fs.unlinkSync(path);
  for (const name of fs.readdirSync(path)) remove(`${path}/${name}`);
  fs.rmdirSync(path);
};
fs.rmSync = (path, options) => !fs.existsSync(path) || !options?.recursive && fs.lstatSync(path).isDirectory()
  ? removeEntry(path, options) : remove(String(path));
fs.renameSync = (from, to) => {
  if (String(from) !== String(to) && fs.existsSync(to) && !fs.lstatSync(to).isDirectory()) fs.unlinkSync(to);
  moveEntry(from, to);
};
fs.promises.rm = async (path, options) => fs.rmSync(path, options);
fs.promises.rename = async (from, to) => fs.renameSync(from, to);

export default fs;
export const { accessSync, appendFileSync, closeSync, constants, copyFileSync, createReadStream,
  createWriteStream, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  promises, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync,
  unlinkSync, writeFileSync, writeSync } = fs;
