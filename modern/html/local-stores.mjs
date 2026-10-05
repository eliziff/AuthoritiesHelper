// Local legal data a page gives its runtime: an A2AJ store and the journals database, files the user
// chose, read in place by node:sqlite (node/sqlite.mjs) at the paths Beaver's lookups open.
import { mountFile, ready } from "node:sqlite";
import { process } from "./node/globals.mjs";
import { useA2AJCorpus } from "../../../backend/src/lib/legalSources/a2aj";
import { journalLegalSourceProvider } from "../../../backend/src/lib/legalSources/journal";

const A2AJ = "/stores/a2aj/a2aj.sqlite", JOURNALS = "/stores/journals/public_endpoint.db";

/** The "mount-store" operation: reads `file` as the store, or stops reading it (null). For A2AJ,
 *  `localOnly` keeps every lookup on this computer. */
export async function mountStore({ store, file, localOnly }) {
  await ready;
  if (store === "a2aj") {
    mountFile(A2AJ, file);
    useA2AJCorpus(file ? A2AJ : null, { localOnly: !!localOnly });
  } else {
    // Connections and articles kept from the previous file must not answer for this one.
    journalLegalSourceProvider.closeDatabases();
    mountFile(JOURNALS, file);
    if (file) process.env.MIKE_PUBLIC_ENDPOINT_DB = JOURNALS;
    else delete process.env.MIKE_PUBLIC_ENDPOINT_DB;
  }
  return { data: null };
}
