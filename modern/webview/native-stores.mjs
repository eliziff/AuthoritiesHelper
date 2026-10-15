// The "mount-store" operation of a desktop program's runtime (native-runtime.mjs): the local legal data its page
// names, as the page's own runtime takes it (../html/local-stores.mjs), each read where it lies (node-sqlite.mjs).
// The A2AJ store is a file of its own, read by its path, by the engine as well as by the lookups.
import path from "node:path";
import { useA2AJCorpus } from "../../../backend/src/lib/legalSources/a2aj";
import { journalLegalSourceProvider } from "../../../backend/src/lib/legalSources/journal";
import { keepLocal } from "../html/undici.mjs";
import { DatabaseSync, mountFile, ready, servedFile } from "./node-sqlite.mjs";

// Without a store the page names, there is none: the lookups' own default is not read, as a page's runtime has none.
const NO_A2AJ = path.resolve("/stores/a2aj/a2aj.sqlite");
const JOURNALS_SEARCH = path.resolve("/stores/journals/public_endpoint-search.sqlite");
const journals = { database: null, search: null, at: null };
let a2aj = null;
useA2AJCorpus(NO_A2AJ);

/** Reads `file` as the store, or stops reading it (null). For A2AJ, `localOnly` keeps every lookup on this
 *  computer: A2AJ, the National Archives, Justice Laws and the publisher PDF service are asked nothing. */
export async function mountStore({ store, file, localOnly }) {
  if (store === "a2aj") {
    keepLocal(!!localOnly);
    const place = file ? servedFile(file) : null;
    if (place?.offset) throw new Error("The A2AJ store is read by its own path.");
    a2aj = place?.path ?? null;
    useA2AJCorpus(a2aj ?? NO_A2AJ, { localOnly: !!localOnly });
    return { data: null };
  }
  await ready;
  // Connections and articles kept from the previous files must not answer for these.
  journalLegalSourceProvider.closeDatabases();
  journals[store === "journals-search" ? "search" : "database"] = file;
  if (journals.at) mountFile(journals.at, null);
  mountFile(JOURNALS_SEARCH, journals.search);
  // The database is read only with the index built from it, at the path the index records, where it stats as its
  // file, as the provider checks.
  const recorded = journals.database && journals.search ? indexedSource(journals.database) : "";
  journals.at = recorded ? path.resolve(recorded) : null;
  if (journals.at) {
    mountFile(journals.at, journals.database);
    process.env.MIKE_PUBLIC_ENDPOINT_DB = recorded;
  } else delete process.env.MIKE_PUBLIC_ENDPOINT_DB;
  if (journals.search) process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = JOURNALS_SEARCH;
  else delete process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;
  return { data: null };
}

/** The path the index records for the database it was built from, when `database` is that file (its size and
 *  modification time); otherwise "". */
function indexedSource(database) {
  let index;
  try {
    index = new DatabaseSync(JOURNALS_SEARCH);
    const meta = Object.fromEntries(index.prepare("SELECT key, value FROM meta").all().map(({ key, value }) => [key, value]));
    return typeof meta.source_path === "string" && meta.source_size === String(database.size)
      && meta.source_mtime_ms === String(Math.trunc(database.lastModified)) ? meta.source_path : "";
  } catch { return ""; } finally { index?.close(); }
}
