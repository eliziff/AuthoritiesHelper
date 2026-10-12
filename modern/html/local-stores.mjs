// Local legal data a page gives its runtime: an A2AJ store, the journals database and its search index,
// files the user chose, read in place by node:sqlite (node/sqlite.mjs) at the paths Beaver's lookups open.
import path from "node:path";
import { DatabaseSync, mountFile, ready } from "node:sqlite";
import { process } from "./node/globals.mjs";
import { useA2AJCorpus } from "../../../backend/src/lib/legalSources/a2aj";
import { journalLegalSourceProvider } from "../../../backend/src/lib/legalSources/journal";
import { keepLocal } from "./undici.mjs";

const A2AJ = "/stores/a2aj/a2aj.sqlite";
const JOURNALS_SEARCH = "/stores/journals/public_endpoint-search.sqlite";
const CANLII = "/stores/canlii/canlii.db";
const journals = { database: null, search: null, at: null };
let a2ajMounted = false;
let canliiFile = null;

/** The "mount-store" operation: reads `file` as the store, or stops reading it (null). For A2AJ,
 *  `localOnly` keeps every lookup on this computer: A2AJ, the National Archives, Justice Laws and the publisher PDF
 *  service are asked nothing. It holds from the moment the message arrives, before the store is read, so an
 *  operation the page asks for after it never reaches the network. */
export async function mountStore({ store, file, localOnly }) {
  if (store === "a2aj") {
    keepLocal(!!localOnly);
    useA2AJCorpus(a2ajMounted ? A2AJ : null, { localOnly: !!localOnly });
  }
  await ready;
  if (store === "canlii") {
    mountFile(CANLII, file);
    try {
      if (file) {
        const db = new DatabaseSync(CANLII);
        try { db.prepare("SELECT databaseId, caseId, title FROM cases LIMIT 0").all(); }
        finally { db.close(); }
        process.env.ALR_CANLII_DB = CANLII;
      } else delete process.env.ALR_CANLII_DB;
      canliiFile = file;
    } catch (error) { mountFile(CANLII, canliiFile); throw error; }
    return { data: null };
  }
  if (store === "a2aj") {
    mountFile(A2AJ, file);
    a2ajMounted = !!file;
    useA2AJCorpus(file ? A2AJ : null, { localOnly: !!localOnly });
    return { data: null };
  }
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
