import fs from "./fs.mjs";

const promises = fs.promises;
export default promises;
export const { access, appendFile, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir,
  realpath, rename, rm, rmdir, stat, unlink, writeFile } = promises;
