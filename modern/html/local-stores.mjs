// Local legal data a page gives its runtime: an A2AJ store, the journals database and its search index,
// files the user chose, read in place by node:sqlite (node/sqlite.mjs) at the paths Beaver's lookups open.
import path from "node:path";
import { DatabaseSync, mountFile, ready } from "node:sqlite";
import { process } from "./node/globals.mjs";
import { useA2AJCorpus } from "../../../backend/src/lib/legalSources/a2aj";
import { journalLegalSourceProvider } from "../../../backend/src/lib/legalSources/journal";
import { keepLocal } from "./undici.mjs";

const A2AJ = "/stores/a2aj/a2aj.sqlite", JOURNALS = "/stores/journals/public_endpoint.db";
const JOURNALS_SEARCH = "/stores/journals/public_endpoint-search.sqlite";
const journals = { database: null, search: null, at: null };
let a2ajMounted = false;

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
  // The provider searches with the index only when it was built from the database it reads: the path,
  // size and modification time the index records. The database is read at that path, and stats as its file.
  const recorded = journals.database && journals.search ? indexedSource() : "";
  journals.at = journals.database ? path.resolve(recorded || JOURNALS) : null;
  if (journals.at) {
    mountFile(journals.at, journals.database);
    process.env.MIKE_PUBLIC_ENDPOINT_DB = recorded || JOURNALS;
  } else delete process.env.MIKE_PUBLIC_ENDPOINT_DB;
  if (journals.search) process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB = JOURNALS_SEARCH;
  else delete process.env.MIKE_PUBLIC_ENDPOINT_FTS_DB;
  return { data: null };
}

function indexedSource() {
  let index;
  try {
    index = new DatabaseSync(JOURNALS_SEARCH);
    const value = index.prepare("SELECT value FROM meta WHERE key = 'source_path'").get()?.value;
    return typeof value === "string" ? value : "";
  } catch { return ""; } finally { index?.close(); }
}
