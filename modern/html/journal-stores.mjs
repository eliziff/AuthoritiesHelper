// The journals database and its search index as a runtime's "mount-store" operation takes them, the page's
// (local-stores.mjs) and a desktop program's (../webview/native-stores.mjs) alike: files read in place by node:sqlite
// (node/sqlite.mjs, or the program's) at the paths Beaver's lookups open.
import path from "node:path";
import { DatabaseSync, mountFile } from "node:sqlite";
import { process } from "./node/globals.mjs";
import { journalLegalSourceProvider } from "../../../backend/src/lib/legalSources/journal";

const JOURNALS_SEARCH = path.resolve("/stores/journals/public_endpoint-search.sqlite");
const journals = { database: null, search: null, at: null };

/** Reads `file` as the journals database ("journals") or its search index ("journals-search"); null stops reading it. */
export function mountJournals(store, file) {
  // Connections and articles kept from the previous files must not answer for these.
  journalLegalSourceProvider.closeDatabases();
  journals[store === "journals-search" ? "search" : "database"] = file;
  if (journals.at) mountFile(journals.at, null);
  mountFile(JOURNALS_SEARCH, journals.search);
  // The database is read only with the index built from it: without one, each search reads the whole database, which
  // takes minutes in a page. It is read at the path the index records, and stats as its file, as the provider checks.
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
