// The "mount-store" operation of a desktop program's runtime (native-runtime.mjs): the local legal data its page
// names, as the page's own runtime takes it (../html/local-stores.mjs), each read where it lies (node-sqlite.mjs).
// The A2AJ store is a file of its own, read by its path, by the engine as well as by the lookups.
import path from "node:path";
import { useA2AJCorpus } from "../../../backend/src/lib/legalSources/a2aj";
import { mountJournals } from "../html/journal-stores.mjs";
import { keepLocal } from "../html/undici.mjs";
import { ready, servedFile } from "./node-sqlite.mjs";

// Without a store the page names, there is none: the lookups' own default is not read, as a page's runtime has none.
const NO_A2AJ = path.resolve("/stores/a2aj/a2aj.sqlite");
useA2AJCorpus(NO_A2AJ);

/** Reads `file` as the store, or stops reading it (null). For A2AJ, `localOnly` keeps every lookup on this
 *  computer: A2AJ, the National Archives, Justice Laws and the publisher PDF service are asked nothing. */
export async function mountStore({ store, file, localOnly }) {
  if (store === "a2aj") {
    keepLocal(!!localOnly);
    const place = file ? servedFile(file) : null;
    if (place?.offset) throw new Error("The A2AJ store is read by its own path.");
    useA2AJCorpus(place?.path ?? NO_A2AJ, { localOnly: !!localOnly });
    return { data: null };
  }
  await ready;
  return mountJournals(store, file);
}
