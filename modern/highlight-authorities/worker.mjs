// MIT. Public-publisher retrieval only: no PDF uploads, OCR, or document storage.
import { acquirePdf, DECISIA_HOSTS, LIMITS, SourceError } from './network.mjs';
export function createWorker(fetcher = fetch) {
  return {
    async fetch(request, env = {}) {
      // Every response, including an unexpected failure, must carry CORS headers: without them the
      // browser reports a bare "Failed to fetch" and the real error is lost.
      const state = {};
      try { return await handle(request, env, state); }
      catch { return new Response(JSON.stringify({ error: 'The download service failed unexpectedly. Retry shortly.', code: 'service_error' }),
        { status: 500, headers: { ...state.headers, 'Content-Type': 'application/json' } }); }
    },
  };
  async function handle(request, env, state) {
      const incoming = new URL(request.url), origin = request.headers.get('origin');
      const allowed = new Set((env.ALLOWED_ORIGINS || 'null,https://eliziff.github.io').split(',').map(s => s.trim()).filter(Boolean));
      allowed.add(incoming.origin);
      const headers = { 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Expose-Headers': 'Content-Length, X-Publisher-Pdf-Url', 'Referrer-Policy': 'no-referrer' };
      if (origin && allowed.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
      state.headers = headers;
      const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
      if (origin && !allowed.has(origin)) return json({ error: 'This application origin is not permitted.', code: 'origin_denied' }, 403);
      if (!['/pdf', '/health'].includes(incoming.pathname)) return json({ error: 'Not found.' }, 404);
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method');
        const requested = request.headers.get('access-control-request-headers');
        if ((method && method !== 'GET') || requested) return json({ error: 'Preflight not permitted.' }, 403);
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== 'GET') return json({ error: 'Only GET is supported.' }, 405);
      if (incoming.pathname === '/health') return json({ ok: true, service: 'authorities-provider-pdf', version: 2,
        public: true, publishers: [...DECISIA_HOSTS, 'www.bccourts.ca', 'bccourts.ca'] });
      // Optional Cloudflare rate-limit binding; no in-memory pseudo-global rate limiting.
      if (env.RATE_LIMITER && !(await env.RATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })).success) return json({ error: 'Too many downloads. Retry shortly.', code: 'rate_limited' }, 429);
      const raw = incoming.searchParams.get('source');
      if (!raw || raw.length > 4096 || [...incoming.searchParams.keys()].some(k => k !== 'source')) return json({ error: 'A publisher source URL is required.', code: 'invalid_source' }, 400);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LIMITS.milliseconds);
      const abort = () => controller.abort(); request.signal?.addEventListener('abort', abort, { once: true });
      const finish = () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); };
      try {
        const pdf = await acquirePdf(raw, fetcher, controller.signal, finish);
        const output = { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="authority.pdf"', 'X-Publisher-Pdf-Url': pdf.url };
        if (/^\d+$/.test(pdf.length || '')) output['Content-Length'] = pdf.length;
        return new Response(pdf.body, { status: 200, headers: output });
      } catch (error) {
        finish();
        if (controller.signal.aborted) return json({ error: 'Publisher download timed out or was cancelled.', code: 'timeout' }, 504);
        return json({ error: error instanceof SourceError ? error.message : 'The publisher could not be reached.', code: error.code || 'publisher_error' }, error.status || 502);
      }
  }
}
export default createWorker();
