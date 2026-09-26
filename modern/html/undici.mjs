// Outbound requests from the runtime. Hosts that serve browsers directly (A2AJ
// sends Access-Control-Allow-Origin: *) are fetched from the page; every other
// source goes through the Authorities relay, which returns the upstream status,
// headers and redirects that the runtime's own redirect handling expects.

const DIRECT_HOSTS = new Set(["api.a2aj.ca"]);

export class Agent {
  constructor() {}
  close() { return Promise.resolve(); }
}

function relayUrl() {
  return globalThis.AUTHORITIES_RELAY_URL || null;
}

export async function fetch(input, init = {}) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const { dispatcher: _dispatcher, duplex: _duplex, redirect, ...rest } = init;
  if (DIRECT_HOSTS.has(url.hostname)) {
    return globalThis.fetch(url, { ...rest, credentials: "omit", referrerPolicy: "no-referrer",
      redirect: redirect === "manual" ? "follow" : redirect });
  }
  const relay = relayUrl();
  if (!relay) throw new Error(`${url.hostname} can only be reached through the Authorities relay, ` +
    "which this copy is not configured with. Attach the PDF instead.");
  const headers = new Headers(rest.headers);
  const response = await globalThis.fetch(new URL("/relay", relay), {
    method: "POST", signal: rest.signal, credentials: "omit", referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.href, method: rest.method ?? "GET",
      headers: Object.fromEntries(headers), body: typeof rest.body === "string" ? rest.body : null }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error ?? `The Authorities relay could not reach ${url.hostname}.`);
  }
  const status = Number(response.headers.get("x-relay-status")) || 502;
  const upstream = new Headers(JSON.parse(response.headers.get("x-relay-headers") || "{}"));
  return new Response([101, 204, 205, 304].includes(status) ? null : response.body,
    { status, statusText: response.headers.get("x-relay-status-text") ?? "", headers: upstream });
}
export default { Agent, fetch };
