// Outbound requests from the runtime. Hosts that serve browsers directly (A2AJ
// sends Access-Control-Allow-Origin: *) are fetched from the page. Court publisher
// PDFs come from the Cloudflare Worker Authorities-lite uses, which returns the
// publisher's own PDF for a decision page or PDF URL. No other source is reachable from
// the page; its PDF is attached instead. A page built without network reaches none of them.
import { DECISIA_HOSTS, LEGISLATION_PDF_HOSTS } from "../../../backend/src/lib/legalSourcePresentation.ts";

import { DEFAULT_SERVICE_URL } from "../provider-pdf-service.mjs";
import { keepAnswer, keepPdf, keptAnswer, keptPdf } from "./source-pdf-cache.mjs";
import { process } from "./node/globals.mjs";

const DIRECT_HOSTS = new Set(["api.a2aj.ca"]);
// A page built with the ukCaseLaw option (the ALR Quote Verifier) also reads UK decisions from the National
// Archives' Find Case Law, which serves browsers directly too (Access-Control-Allow-Origin: *).
if (__UK_CASE_LAW__) {
  DIRECT_HOSTS.add("caselaw.nationalarchives.gov.uk");
  DIRECT_HOSTS.add("www.gov.uk");
  DIRECT_HOSTS.add("www.courtlistener.com");
}
const CANLII_HOSTS = new Set(["www.canlii.org", "canlii.org", "www.canlii.ca", "canlii.ca"]);
const FOREIGN_HOSTS = new Set(__UK_CASE_LAW__ ? ["storage.courtlistener.com",
  "api.govinfo.gov", "www.govinfo.gov", "assets.publishing.service.gov.uk"] : []);
// Justice Laws serves its pages to browsers directly too (Access-Control-Allow-Origin: *): an annual
// statute's page is read for its title, while its PDF still comes through the service.
const directPage = (url) => url.hostname === "laws-lois.justice.gc.ca" && /^\/eng\/AnnualStatutes\/\d{4}_\d{1,3}\/$/u.test(url.pathname);
// The page keeps A2AJ's answers for a day, as long as the runtime's own cache does, so a visit
// after a reload does not ask A2AJ again; a decision A2AJ sent for its citation, which does not
// change, for a month. A lookup that failed is asked again.
const ANSWER_TTL_MS = 24 * 60 * 60_000;
const DECISION_TTL_MS = 30 * ANSWER_TTL_MS;
const answerLifetime = (url) => url.pathname === "/fetch" && url.searchParams.get("doc_type") === "cases"
  && !url.searchParams.has("section") ? DECISION_TTL_MS : ANSWER_TTL_MS;

async function directAnswer(url, init) {
  const read = (init.method ?? "GET").toUpperCase() === "GET";
  const kept = read && await keptAnswer(url.href);
  if (kept) return new Response(kept, { headers: { "content-type": "application/json" } });
  const response = await globalThis.fetch(url, init);
  if (!read || !response.ok || !/json/u.test(response.headers.get("content-type") ?? "")) return response;
  const body = await response.text();
  // An empty answer (the decision is not in A2AJ yet) is kept only a day.
  keepAnswer(url.href, body, Date.now() + (/"results"\s*:\s*\[\s*\]/u.test(body) ? ANSWER_TTL_MS : answerLifetime(url)));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
// The legal source and publisher PDF services are asked over the network, except by a desktop program's runtime
// (../webview/native-runtime.mjs), which asks the program's own.
let serviceFetch = (url, init) => globalThis.fetch(url, init);
export const useServiceFetch = (fetch) => { serviceFetch = fetch; };
async function providerAnswer(url, init) {
  const endpoint = process.env.ALR_PROVIDER_SERVICE_URL || new URL("source", DEFAULT_SERVICE_URL).href;
  const headers = new Headers(init.headers), token = headers.get("authorization")?.replace(/^Token\s+/iu, "")
    || (url.hostname === "api.govinfo.gov" ? url.searchParams.get("api_key") : null);
  const source = new URL(url);
  source.searchParams.delete("api_key");
  const pdf = /pdf/iu.test(headers.get("accept") ?? "") || /(?:\.pdf|\/pdf)$/iu.test(source.pathname);
  const response = await serviceFetch(endpoint, { method: "POST", signal: init.signal,
    credentials: "omit", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: source.href, method: init.method ?? "GET",
      ...init.body ? { body: String(init.body) } : {}, ...token ? { token } : {},
      accept: pdf ? "application/pdf" : "application/json" }) });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    // The source's own answer (its status, CanLII's challenge) is given as the source gave it, as a direct fetch sees it.
    if (detail?.code === "provider_http" || detail?.code === "verification_required") return new Response(null, {
      status: response.status, headers: detail.code === "verification_required" ? { "cf-mitigated": "challenge" } : {} });
    throw Object.assign(new Error(detail?.error ?? `The legal source service could not reach ${url.hostname} (${response.status}).`),
      { status: response.status, code: detail?.code });
  }
  return response;
}
const PUBLISHER_HOSTS = new Set([...DECISIA_HOSTS, "www.bccourts.ca", "bccourts.ca", ...LEGISLATION_PDF_HOSTS]);

// A PDF fetched is shared by every request for it while it is fetched and for a minute after: a check reads a decision
// once for each of its quotations, at once or in turn.
const SHARED_MS = 60_000;
const shared = new Map();
async function publisherPdf(url, init) {
  if ((init.method ?? "GET").toUpperCase() !== "GET")
    throw new Error(`${url.hostname} is only read, never written to.`);
  // The service sends a publisher's PDF, never its pages: a request for a page (a decision's index, read for its PDF
  // link) is refused at once rather than answered with the whole PDF.
  const accept = new Headers(init.headers).get("accept");
  if (accept && !/pdf|\*\/\*/u.test(accept)) throw new Error(`${url.hostname} pages cannot be read from this page.`);
  // A PDF the page verified before, in this visit or an earlier one, is not fetched again.
  const kept = await keptPdf(url.href);
  if (kept) return new Response(kept, { headers: { "content-type": "application/pdf" } });
  let fetched = shared.get(url.href);
  if (!fetched) {
    shared.set(url.href, fetched = servicePdf(url, init));
    fetched.then(() => setTimeout(() => shared.delete(url.href), SHARED_MS), () => shared.delete(url.href));
  }
  const { bytes, status, headers } = await fetched;
  return new Response(bytes.slice(), { status, headers });
}
async function servicePdf(url, init) {
  const service = new URL(process.env.ALR_PDF_SERVICE_URL || new URL("pdf", DEFAULT_SERVICE_URL).href);
  service.searchParams.set("source", url.href);
  const request = { signal: init.signal, credentials: "omit", referrerPolicy: "no-referrer" };
  let response;
  try { response = await serviceFetch(service, request); }
  catch (error) {
    // The service answers a page whose address it does not serve without letting it read the
    // answer, which fails as a network failure does; an opaque request resolves for any answer.
    if (!(error instanceof TypeError) || !await serviceFetch(service, { ...request, method: "HEAD",
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
  return { bytes, status: response.status, headers: response.headers };
}

export class Agent {
  constructor() {}
  close() { return Promise.resolve(); }
}

// "Use only local data" (local-stores.mjs): no host is asked anything while it is on.
let localOnly = false;
export const keepLocal = (value) => { localOnly = value; };

async function networkFetch(input, init = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (localOnly) throw new Error(`${url.hostname} is not asked: "Use only local data" is on.`);
  const { dispatcher: _dispatcher, duplex: _duplex, redirect, ...rest } = init;
  if (DIRECT_HOSTS.has(url.hostname)) {
    return directAnswer(url, { ...rest, credentials: "omit", referrerPolicy: "no-referrer",
      redirect: redirect === "manual" ? "follow" : redirect });
  }
  if (directPage(url)) return globalThis.fetch(url, { ...rest, credentials: "omit", referrerPolicy: "no-referrer",
    redirect: redirect === "manual" ? "follow" : redirect });
  if (PUBLISHER_HOSTS.has(url.hostname)) return publisherPdf(url, rest);
  if (FOREIGN_HOSTS.has(url.hostname)) return providerAnswer(url, rest);
  if (CANLII_HOSTS.has(url.hostname)) return providerAnswer(url, rest);
  throw new Error(`${url.hostname} cannot be reached from this page. Attach the PDF instead.`);
}
// A page built without network (runtime-bundle.mjs) reaches no host at all, and holds none of the code that would.
export const fetch = __NETWORK__ ? networkFetch : async (input) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  throw new Error(`${url.hostname} cannot be reached: this page reads only data on this computer. Attach the PDF instead.`);
};
export default { Agent, fetch };
