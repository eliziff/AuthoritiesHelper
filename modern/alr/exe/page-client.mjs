// The private edition's page bridge: the same operations the self-contained page runs in its Worker,
// asked of the program that served this page (server.mjs).
import { decodeWire, encodeWire } from "./wire.mjs";

async function folderRequest(op, fields = {}) {
  const response = await fetch("/api/corpus-folder", { method: "POST", body: encodeWire({ op, ...fields }),
    headers: { "Content-Type": "application/json" } });
  const answer = decodeWire(await response.text());
  if (!response.ok) throw new Error(answer.detail ?? `The corpus folder request failed (${response.status})`);
  return answer.result;
}
const FLUSH_BYTES = 8 * 1024 * 1024;
/** The A2AJ corpus folder on this computer that the program reads (an A2AJCorpusFolder, a2ajCorpus.ts):
 *  the corpus panel downloads into it here instead of asking for a folder. */
globalThis.ALR_CORPUS_FOLDER = {
  readText: (path) => folderRequest("readText", { path }),
  writeText: (path, text) => folderRequest("writeText", { path, text }),
  size: (path) => folderRequest("size", { path }),
  read: (path, start, end) => folderRequest("read", { path, start, end }),
  rename: (from, to) => folderRequest("rename", { path: from, to }),
  remove: (path) => folderRequest("remove", { path }),
  async append(path, at) {
    const id = await folderRequest("append", { path, at });
    let pending = [], buffered = 0;
    const flush = async () => {
      if (!buffered) return;
      const body = new Blob(pending); pending = []; buffered = 0;
      const response = await fetch(`/api/corpus-folder/write/${id}`, { method: "POST", body });
      if (!response.ok) throw new Error(`The corpus download could not be saved (${response.status})`);
    };
    return {
      async write(bytes) { pending.push(bytes.slice()); buffered += bytes.byteLength; if (buffered >= FLUSH_BYTES) await flush(); },
      async close() { await flush(); await folderRequest("close", { id }); },
    };
  },
};

globalThis.AUTHORITIES_OPERATIONS = async (operation, input, { signal, progress, quoteProgress } = {}) => {
  let response;
  try {
    response = await fetch(`/api/operations/${operation}`, { method: "POST", body: encodeWire(input), signal,
      headers: { "Content-Type": "application/json" } });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("ALR Quote Verifier has stopped. Start it again to continue.");
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw Object.assign(new Error(detail?.detail ?? `The request failed (${response.status})`), { status: response.status });
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (let buffered = "";;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("ALR Quote Verifier stopped before it finished.");
    buffered += value;
    for (let end; (end = buffered.indexOf("\n")) >= 0;) {
      const message = decodeWire(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      if (message.type === "progress") progress?.(message.value);
      else if (message.type === "quote-progress") quoteProgress?.(message.value);
      else if (message.type === "result") return message.result;
      else if (message.type === "error") throw Object.assign(new Error(message.message), { status: message.status });
    }
  }
};
