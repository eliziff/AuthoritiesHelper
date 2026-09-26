// The Authorities relay (Cloudflare Worker). The self-contained Authorities.html runs
// the source resolver in the browser; publisher sites do not answer browsers across
// origins, so the page asks this relay to make those requests. It reaches only the
// legal-source hosts the resolver itself names, never CanLII, and returns the upstream
// status, headers and redirects unchanged for the resolver's own redirect handling.
import { DECISIA_HOSTS } from "../../../backend/src/lib/legalSourcePresentation";

// Provider hosts from backend/src/lib/legalSources/* and providerPdfLibraryBridge.ts.
const HOSTS = new Set([...DECISIA_HOSTS, "caselaw.nationalarchives.gov.uk", "www.courtlistener.com",
  "storage.courtlistener.com", "archive.org", "api.govinfo.gov", "www.govinfo.gov", "www.gov.uk",
  "www.bccourts.ca", "www.scc-csc.ca", "api.a2aj.ca"]);
const ORIGINS = new Set(["null"]);
const MAX_BYTES = 100 * 1024 * 1024;
const FORWARDED = ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since"];

const canlii = (host) => ["canlii.ca", "canlii.org"].some((domain) => host === domain || host.endsWith(`.${domain}`));

function cors(request, extra = {}) {
  const origin = request.headers.get("origin");
  return { ...(origin && ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Expose-Headers": "x-relay-status, x-relay-status-text, x-relay-headers", ...extra };
}
const refuse = (request, status, error) => new Response(JSON.stringify({ error }), { status,
  headers: cors(request, { "Content-Type": "application/json" }) });

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (pathname === "/health") return new Response("ok", { headers: cors(request) });
    if (pathname !== "/relay" || request.method !== "POST") return refuse(request, 404, "Not found.");
    if (!ORIGINS.has(request.headers.get("origin") ?? "")) return refuse(request, 403, "This page may not use the relay.");
    let input;
    try { input = await request.json(); } catch { return refuse(request, 400, "The relay request is invalid."); }
    let target;
    try { target = new URL(input.url); } catch { return refuse(request, 400, "The source URL is invalid."); }
    const host = target.hostname.toLowerCase();
    if (target.protocol !== "https:" || target.port || target.username || target.password || canlii(host) || !HOSTS.has(host))
      return refuse(request, 403, `${host} is not a source the relay reaches.`);
    const method = String(input.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST"].includes(method)) return refuse(request, 400, "The relay forwards GET, HEAD and POST.");
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.headers ?? {}))
      if (FORWARDED.includes(name.toLowerCase())) headers.set(name, String(value));
    const upstream = await fetch(target, { method, headers, redirect: "manual",
      body: method === "POST" && typeof input.body === "string" ? input.body : undefined });
    if (Number(upstream.headers.get("content-length")) > MAX_BYTES) return refuse(request, 413, "The source is too large.");
    return new Response(upstream.body, { status: 200, headers: cors(request, {
      "x-relay-status": String(upstream.status), "x-relay-status-text": upstream.statusText,
      "x-relay-headers": JSON.stringify(Object.fromEntries(upstream.headers)) }) });
  },
};
