// Outbound requests from the runtime. Hosts that serve browsers directly (A2AJ
// sends Access-Control-Allow-Origin: *) are fetched from the page. Court publisher
// PDFs come from the Cloudflare Worker Authorities-lite uses, which returns the
// publisher's own PDF for a decision page or PDF URL. No other source is reachable from
// the page; its PDF is attached instead.
import { DECISIA_HOSTS, LEGISLATION_PDF_HOSTS } from "../authorities-lite/publisher.mjs";

import { DEFAULT_SERVICE_URL } from "../provider-pdf-service.mjs";
import { keepAnswer, keepPdf, keptAnswer, keptPdf } from "./source-pdf-cache.mjs";

const DIRECT_HOSTS = new Set(["api.a2aj.ca"]);
// Justice Laws serves its pages to browsers directly too (Access-Control-Allow-Origin: *): an annual
// statute's page is read for its title, while its PDF still comes through the service.
const directPage = (url) => url.hostname === "laws-lois.justice.gc.ca" && /^\/eng\/AnnualStatutes\/\d{4}_\d{1,3}\/$/u.test(url.pathname);
// The page keeps A2AJ's answers for a day, as long as the runtime's own cache does, so a visit
// after a reload does not ask A2AJ again. A lookup that failed is asked again.
const ANSWER_TTL_MS = 24 * 60 * 60_000;

async function directAnswer(url, init) {
  const read = (init.method ?? "GET").toUpperCase() === "GET";
  const kept = read && await keptAnswer(url.href);
  if (kept) return new Response(kept, { headers: { "content-type": "application/json" } });
  const response = await globalThis.fetch(url, init);
  if (!read || !response.ok || !/json/u.test(response.headers.get("content-type") ?? "")) return response;
  const body = await response.text();
  keepAnswer(url.href, body, Date.now() + ANSWER_TTL_MS);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
const PUBLISHER_HOSTS = new Set([...DECISIA_HOSTS, "www.bccourts.ca", "bccourts.ca", ...LEGISLATION_PDF_HOSTS]);

async function publisherPdf(url, init) {
  if ((init.method ?? "GET").toUpperCase() !== "GET")
    throw new Error(`${url.hostname} is only read, never written to.`);
  // A PDF the page verified before, in this visit or an earlier one, is not fetched again.
  const kept = await keptPdf(url.href);
  if (kept) return new Response(kept, { headers: { "content-type": "application/pdf" } });
  const service = new URL("pdf", DEFAULT_SERVICE_URL);
  service.searchParams.set("source", url.href);
  const request = { signal: init.signal, credentials: "omit", referrerPolicy: "no-referrer" };
  let response;
  try { response = await globalThis.fetch(service, request); }
  catch (error) {
    // The service answers a page whose address it does not serve without letting it read the
    // answer, which fails as a network failure does; an opaque request resolves for any answer.
    if (!(error instanceof TypeError) || !await globalThis.fetch(service, { ...request, method: "HEAD",
      mode: "no-cors" }).then(() => true, () => false)) throw error;
    throw Object.assign(new Error("The publisher PDF service does not serve this page's address."),
      { code: "origin_denied" });
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw Object.assign(new Error(detail?.error ?? `The publisher PDF service could not reach ${url.hostname}.`),
      { code: detail?.code, verificationUrl: detail?.verificationUrl ?? null, pdfUrl: detail?.pdfUrl });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (response.headers.get("content-type")?.startsWith("application/pdf")) await keepPdf(url.href, bytes);
  return new Response(bytes, { status: response.status, headers: response.headers });
}

export class Agent {
  constructor() {}
  close() { return Promise.resolve(); }
}

export async function fetch(input, init = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const { dispatcher: _dispatcher, duplex: _duplex, redirect, ...rest } = init;
  if (DIRECT_HOSTS.has(url.hostname)) {
    return directAnswer(url, { ...rest, credentials: "omit", referrerPolicy: "no-referrer",
      redirect: redirect === "manual" ? "follow" : redirect });
  }
  if (directPage(url)) return globalThis.fetch(url, { ...rest, credentials: "omit", referrerPolicy: "no-referrer",
    redirect: redirect === "manual" ? "follow" : redirect });
  if (PUBLISHER_HOSTS.has(url.hostname)) return publisherPdf(url, rest);
  throw new Error(`${url.hostname} cannot be reached from this page. Attach the PDF instead.`);
}
export default { Agent, fetch };
