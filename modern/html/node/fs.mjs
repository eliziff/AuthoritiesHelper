// The runtime's one filesystem: Node's fs API over memory, shared with the engine's WASI.
import { Volume, createFsFromVolume } from "memfs";

export const volume = new Volume();
const fs = createFsFromVolume(volume);
for (const directory of ["/tmp", "/home/authorities"]) fs.mkdirSync(directory, { recursive: true });

export default fs;
export const { accessSync, appendFileSync, closeSync, constants, copyFileSync, createReadStream,
  createWriteStream, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  promises, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync,
  unlinkSync, writeFileSync, writeSync } = fs;
