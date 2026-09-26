// The two Node crypto operations the runtime uses: synchronous SHA-256 and random UUIDs.
import { sha256 } from "@noble/hashes/sha2.js";
import { Buffer } from "buffer";

const encoder = new TextEncoder();

export function createHash(algorithm) {
  if (String(algorithm).toLowerCase() !== "sha256") throw new Error(`Unsupported hash ${algorithm}`);
  const hash = sha256.create();
  const digest = {
    update(data, encoding) {
      hash.update(typeof data === "string" ? (encoding && encoding !== "utf8" && encoding !== "utf-8"
        ? Buffer.from(data, encoding) : encoder.encode(data))
        : data instanceof Uint8Array ? data : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength));
      return digest;
    },
    digest(encoding) {
      const out = Buffer.from(hash.digest());
      return encoding ? out.toString(encoding) : out;
    },
  };
  return digest;
}

export const randomUUID = () => globalThis.crypto.randomUUID();
export const randomBytes = (size) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
export const webcrypto = globalThis.crypto;
export default { createHash, randomUUID, randomBytes, webcrypto };
