// Local legal data a page gives its runtime: an A2AJ store, the journals database and its search index,
// files the user chose, read in place by node:sqlite (node/sqlite.mjs) at the paths Beaver's lookups open.
import { mountFile, ready } from "node:sqlite";
import { useA2AJCorpus } from "../../../backend/src/lib/legalSources/a2aj";
import { mountJournals } from "./journal-stores.mjs";
import { keepLocal } from "./undici.mjs";

const A2AJ = "/stores/a2aj/a2aj.sqlite";
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
  return mountJournals(store, file);
}
