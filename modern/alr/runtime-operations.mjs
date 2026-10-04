// The ALR runtime's operations. The shared Authorities runtime Worker (html/runtime-worker.mjs) serves
// whatever createAuthoritiesOperations() returns; the ALR build points that import here, so the page
// gets Beaver's verifier with the same engine, network shim and caches Authorities.html has.
import { createAlrVerifierOperations } from "../../../backend/src/lib/alrVerifier/operations";
import { providerLlm } from "./providers/llm.mjs";

export function createAuthoritiesOperations() {
  const operations = createAlrVerifierOperations();
  // The Worker calls an operation with (input, { signal, progress }); the verifier takes (input, progress).
  // The page sends the chosen provider's settings; the model is called from this Worker.
  return {
    run: (input, { signal, progress }) =>
      operations.run({ ...input, signal, llm: input.llm ? providerLlm(input.llm) : undefined }, progress),
    attachSource: (input, { progress }) => operations.attachSource(input, progress),
  };
}
