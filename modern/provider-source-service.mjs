// Read the public APIs the standalone browser cannot read through CORS. No arbitrary URLs or uploads.
import { readBounded, validatedPdfStream, SourceError } from './authorities-lite/network.mjs';

const COURTLISTENER = /^\/api\/rest\/v4\/(?:citation-lookup\/|search\/|clusters\/\d+\/|opinions\/(?:\d+\/)?)$/u;
const GOVINFO = /^\/packages\/USCOURTS-[A-Za-z0-9_-]+\/(?:summary|pdf)$/u;
const GOVINFO_PDF = /^\/content\/pkg\/(USCOURTS-[A-Za-z0-9_-]+)\/pdf\/\1\.pdf$/u;
const GOVUK_PDF = /^\/(?:media\/[A-Za-z0-9_-]+|government\/uploads\/system\/uploads\/attachment_data\/file\/\d+)\/[^/]+\.pdf$/iu;
const COURTLISTENER_PDF = /^\/[A-Za-z0-9_%./-]+\.pdf$/iu;
const CANLII_DOCUMENT = /^\/(?:en|fr)\/(?:[a-z]{2}\/[a-z0-9_-]+\/doc\/\d{4}\/[a-z0-9_-]+\/[a-z0-9_-]+\.(?:html|pdf)|[a-z]{2}\/laws\/(?:stat|regu)\/[a-z0-9_.-]+\/(?:latest|[0-9.-]+)\/[a-z0-9_.-]+\.html)$/iu;

function sourceRequest(input, credentials) {
  let url;
  try { url = new URL(input.source); } catch { throw new SourceError('Invalid legal source URL.', 400, 'invalid_source'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || /\\|%(?:00|2f|5c)/iu.test(url.pathname))
    throw new SourceError('Invalid legal source URL.', 400, 'invalid_source');
  const method = input.method ?? 'GET', headers = { Accept: input.accept === 'application/pdf' ? 'application/pdf' : 'application/json' };
  const post = method === 'POST';
  const api = url.hostname === 'www.courtlistener.com' && COURTLISTENER.test(url.pathname)
    && (post ? url.pathname.endsWith('/citation-lookup/') : method === 'GET')
    || url.hostname === 'api.govinfo.gov' && (post ? url.pathname === '/search' : method === 'GET' && GOVINFO.test(url.pathname));
  const pdf = method === 'GET' && (url.hostname === 'www.govinfo.gov' && GOVINFO_PDF.test(url.pathname)
    || url.hostname === 'assets.publishing.service.gov.uk' && GOVUK_PDF.test(url.pathname)
    || url.hostname === 'storage.courtlistener.com' && COURTLISTENER_PDF.test(url.pathname));
  const canlii = method === 'GET' && ['www.canlii.org', 'canlii.org', 'www.canlii.ca', 'canlii.ca'].includes(url.hostname)
    && CANLII_DOCUMENT.test(url.pathname);
  if (!api && !pdf && !canlii) throw new SourceError('This legal source URL is not supported.', 400, 'unsupported_source');
  if (canlii) headers.Accept = /\.pdf$/iu.test(url.pathname) ? 'application/pdf' : 'text/html';
  if ((!input.token || input.token === 'DEMO_KEY') && credentials[url.hostname]) input.token = credentials[url.hostname];
  if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 4096 || /[\r\n]/u.test(input.token)))
    throw new SourceError('Invalid provider credential.', 400, 'invalid_credential');
  if (url.hostname === 'www.courtlistener.com' && input.token) headers.Authorization = `Token ${input.token}`;
  if (url.hostname === 'api.govinfo.gov') {
    const key = input.token || url.searchParams.get('api_key') || 'DEMO_KEY';
    url.searchParams.delete('api_key');
    headers['X-Api-Key'] = key;
  }
  if (post) {
    if (typeof input.body !== 'string' || input.body.length > 128_000)
      throw new SourceError('A bounded provider lookup is required.', 400, 'invalid_request');
    headers['Content-Type'] = url.hostname === 'www.courtlistener.com'
      ? 'application/x-www-form-urlencoded' : 'application/json';
  }
  url.hash = '';
  return { url, init: { method, headers, ...post ? { body: input.body } : {} } };
}

export async function readProviderSource(request, fetcher = fetch, credentials = {}) {
  const bytes = await readBounded(request, 132_000);
  let input;
  try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new SourceError('Invalid provider lookup.', 400, 'invalid_request'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SourceError('Invalid provider lookup.', 400, 'invalid_request');
  const { url, init } = sourceRequest(input, credentials);
  const response = await fetcher(url.href, { ...init, redirect: 'manual', signal: AbortSignal.any([
    request.signal, AbortSignal.timeout(30_000)]), credentials: 'omit', referrerPolicy: 'no-referrer' });
  const type = (response.headers.get('content-type') ?? '').split(';')[0].toLowerCase();
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new SourceError('The legal source redirected. Open its page and attach its PDF.', 502, 'unsafe_redirect');
  }
  if (!response.ok) { await response.body?.cancel(); throw new SourceError(`The legal source returned HTTP ${response.status}.`, response.status, 'provider_http'); }
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': type };
  if (type === 'application/pdf' || type === 'application/octet-stream')
    return new Response(await validatedPdfStream(response), { headers: { ...headers, 'Content-Type': 'application/pdf' } });
  if (['www.canlii.org', 'canlii.org', 'www.canlii.ca', 'canlii.ca'].includes(url.hostname) &&
      ['text/html', 'application/xhtml+xml'].includes(type)) {
    if (response.headers.get('cf-mitigated') === 'challenge') {
      await response.body?.cancel();
      throw new SourceError('CanLII requires a browser visit. Open its page and attach the PDF.', 403, 'verification_required');
    }
    return new Response(await readBounded(response, 32 * 1024 * 1024), { headers });
  }
  if (!/^application\/(?:json|[^;]+\+json)$/u.test(type)) {
    await response.body?.cancel();
    throw new SourceError('The legal source did not return API data. Open its page and attach its PDF.', 502, 'not_json');
  }
  return new Response(await readBounded(response, 64 * 1024 * 1024), { headers });
}
