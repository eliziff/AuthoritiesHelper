// multer's API over form parts the in-page adapter already decoded. Files are
// staged in the runtime filesystem, where routes read them by path as on a server.
import fs from "./node/fs.mjs";
import { Buffer } from "buffer";

export class MulterError extends Error {
  constructor(code, field) {
    super({ LIMIT_FILE_SIZE: "File too large", LIMIT_FILE_COUNT: "Too many files",
      LIMIT_UNEXPECTED_FILE: "Unexpected field", LIMIT_FIELD_COUNT: "Too many fields" }[code] ?? code);
    this.name = "MulterError"; this.code = code; this.field = field;
  }
}

// Like multer, files from a rejected upload are removed rather than left behind.
const discard = (files) => { for (const { path } of files) try { fs.unlinkSync(path); } catch { /* gone */ } };

function stage(options, accept) {
  return (request, _response, callback) => {
    const fields = {}, files = [];
    // The staged file is the upload from here on; the decoded copy is not kept alongside it.
    const parts = request.formParts ?? [];
    delete request.formParts;
    try {
      for (const [name, value] of parts) {
        if (typeof value === "string") { fields[name] = value; continue; }
        if (!accept(name)) throw new MulterError("LIMIT_UNEXPECTED_FILE", name);
        if (value.bytes.byteLength > (options.limits?.fileSize ?? Infinity))
          throw new MulterError("LIMIT_FILE_SIZE", name);
        const filename = `upload-${globalThis.crypto.randomUUID()}`, destination = options.storage?.destination ?? "/tmp";
        const path = `${destination}/${filename}`;
        fs.writeFileSync(path, Buffer.from(value.bytes));
        files.push({ fieldname: name, originalname: value.name, encoding: "7bit", mimetype: value.type,
          size: value.bytes.byteLength, destination, filename, path });
      }
      if (files.length > (options.limits?.files ?? Infinity)) throw new MulterError("LIMIT_FILE_COUNT");
    } catch (error) { discard(files); return callback(error); }
    request.body = { ...(request.body ?? {}), ...fields };
    callback(null, files);
  };
}

export default function multer(options = {}) {
  return {
    single: (field) => {
      const run = stage(options, (name) => name === field);
      return (request, response, next) => run(request, response, (error, files) => {
        if (!error) request.file = files[0]; next(error);
      });
    },
    array: (field, maxCount) => {
      const run = stage(options, (name) => name === field);
      return (request, response, next) => run(request, response, (error, files) => {
        if (!error && files.length > maxCount) {
          discard(files); error = new MulterError("LIMIT_UNEXPECTED_FILE", field);
        }
        if (!error) request.files = files; next(error);
      });
    },
  };
}
multer.diskStorage = (storage) => storage;
multer.MulterError = MulterError;
