// MIT. Publisher representation discovery is reused from Beaver.
import { DECISIA_HOSTS, legislationPdfUrl, publisherChallengeUrl, publisherPdfCandidate, verifiedDecisiaPdf, rankedPublisherPdfLinks } from './publisher.mjs';
export { DECISIA_HOSTS, LEGISLATION_PDF_HOSTS } from './publisher.mjs';
export const LIMITS = { html: 2_000_000, statuteHtml: 40_000_000, pdf: 100 * 1024 * 1024, hops: 5, milliseconds: 60_000 };
export class SourceError extends Error {
  constructor(message, status = 502, code = 'publisher_error', verificationUrl = null) { super(message); this.status = status; this.code = code; this.verificationUrl = verificationUrl; }
}
export function sourceUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new SourceError('Invalid publisher URL.', 400, 'invalid_source'); }
  // An official statute or regulation PDF: one of the paths each legislation publisher serves its
  // PDFs at (Manitoba's with its query), checked whole.
  const legislation = !url.username && !url.password && legislationPdfUrl(url);
  if (legislation) return legislation;
  const bc = ['www.bccourts.ca', 'bccourts.ca'].includes(url.hostname);
  const validPath = DECISIA_HOSTS.has(url.hostname)
    ? /^\/[a-z0-9/_-]+\/(?:item\/\d+\/index\.do|\d+\/document\.do)$/i.test(url.pathname)
    : bc && /^\/jdb-txt\/(?:sc|ca)\/[a-z0-9/_-]+\.(?:htm|html|pdf)$/i.test(url.pathname);
  // An old B.C. metadata URL may use HTTP; use its HTTPS equivalent, never send credentials.
  if (bc && url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !validPath ||
      /[%\\]/.test(url.pathname)) throw new SourceError('This publisher URL is not supported by the download service.', 400, 'unsupported_source');
  url.hash = ''; url.search = '';
  return url;
}
const mediaType = response => (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
const verificationError = url => new SourceError('Automatic download blocked.', 403, 'verification_required', url);
async function discard(response) { await response.body?.cancel().catch(() => {}); }
export async function readBounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await discard(response); throw new SourceError('Publisher response exceeds the size limit.', 413, 'too_large'); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SourceError('Publisher response exceeds the size limit.', 413, 'too_large');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function publisherFetch(url, source, fetcher, signal) {
  for (let hop = 0; hop <= LIMITS.hops; hop++) {
    // Check every redirect before fetching it, not merely the initial URL.
    const checked = sourceUrl(url.href);
    if (checked.origin !== source.origin) throw new SourceError('Publisher redirected outside its approved origin.', 502, 'unsafe_redirect');
    // A publisher that refuses a client that does not name itself (LégisQuébec) gets one that does.
    const response = await fetcher(url.href, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/pdf,text/html,application/xhtml+xml;q=0.9,application/octet-stream;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; Beaver-Authorities/1.0)' }, signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (['text/html', 'application/xhtml+xml'].includes(mediaType(response))) {
        const body = await readBounded(response, LIMITS.html);
        const markup = new TextDecoder().decode(body);
        const challengeUrl = publisherChallengeUrl(markup, url);
        if (challengeUrl || response.headers.get('cf-mitigated') === 'challenge')
          throw verificationError(challengeUrl);
        const replacement = new Response(body, { status: response.status, headers: response.headers });
        if (!replacement.ok) throw new SourceError(`Publisher returned HTTP ${response.status}.`, response.status === 404 ? 404 : 502, 'publisher_http');
        return { response: replacement, url };
      }
      if (!response.ok) { await discard(response); throw new SourceError(`Publisher returned HTTP ${response.status}.`, response.status === 404 ? 404 : 502, 'publisher_http'); }
      return { response, url };
    }
    const location = response.headers.get('location'); await discard(response);
    if (!location || hop === LIMITS.hops) throw new SourceError('Publisher redirect limit exceeded.', 502, 'redirect_limit');
    url = new URL(location, url);
    const challengeUrl = publisherChallengeUrl('', url);
    if (challengeUrl) throw verificationError(challengeUrl);
  }
}
/** A LégisQuébec consolidation page, the one publisher whose statute text a rebuild reads (its
 *  official text has no other public source): its HTML, bounded, from that page alone. */
export const STATUTE_TEXT_PAGE = /^\/(?:en|fr)\/document\/c[rs]\/[A-Za-z0-9.,%\- ]{1,80}$/u;
export async function acquireStatuteText(raw, fetcher = fetch, signal) {
  let url;
  try { url = new URL(raw); } catch { throw new SourceError('Invalid publisher URL.', 400, 'invalid_source'); }
  const page = (value) => value.protocol === 'https:' && value.hostname === 'www.legisquebec.gouv.qc.ca' &&
    !value.username && !value.password && !value.search && STATUTE_TEXT_PAGE.test(value.pathname);
  if (!page(url)) throw new SourceError('Only a LégisQuébec consolidation page is read as text.', 400, 'invalid_source');
  for (let hop = 0; hop <= LIMITS.hops; hop++) {
    const response = await fetcher(url.href, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Mozilla/5.0 (compatible; Beaver-Authorities/1.0)' }, signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await discard(response);
      const next = location && new URL(location, url);
      if (!next || !page(next)) throw new SourceError('Publisher redirected outside its consolidation pages.', 502, 'unsafe_redirect');
      url = next; continue;
    }
    if (!response.ok) { await discard(response); throw new SourceError(`Publisher returned HTTP ${response.status}.`, response.status === 404 ? 404 : 502, 'publisher_http'); }
    if (!['text/html', 'application/xhtml+xml'].includes(mediaType(response))) { await discard(response); throw new SourceError('Publisher did not return a page.', 502, 'not_html'); }
    return { html: new TextDecoder().decode(await readBounded(response, LIMITS.statuteHtml)), url: url.href };
  }
  throw new SourceError('Publisher redirect limit exceeded.', 502, 'redirect_limit');
}
// Stream without holding the whole PDF in the Worker; enforce a cap even without Content-Length.
export async function validatedPdfStream(response, finish = () => {}) {
  if (!response.body || !['application/pdf', 'application/octet-stream', 'binary/octet-stream'].includes(mediaType(response))) {
    await discard(response); throw new SourceError('Publisher did not return a PDF.', 502, 'not_pdf');
  }
  if (Number(response.headers.get('content-length')) > LIMITS.pdf) {
    await discard(response); throw new SourceError('PDF exceeds the 100 MiB limit.', 413, 'too_large');
  }
  const reader = response.body.getReader(); const prefix = []; let size = 0;
  try {
    while (size < 5) {
      const { done, value } = await reader.read();
      if (done) throw new SourceError('Publisher returned an empty or truncated PDF.', 502, 'not_pdf');
      size += value.byteLength; if (size > LIMITS.pdf) throw new SourceError('PDF is too large.', 413, 'too_large');
      prefix.push(value);
    }
    const first = new Uint8Array(5); let copied = 0;
    for (const chunk of prefix) { const part = chunk.subarray(0, 5 - copied); first.set(part, copied); copied += part.length; if (copied === 5) break; }
    if (new TextDecoder().decode(first) !== '%PDF-') throw new SourceError('Publisher response has no PDF signature.', 502, 'not_pdf');
  } catch (error) { await reader.cancel().catch(() => {}); reader.releaseLock(); throw error; }
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (index < prefix.length) { controller.enqueue(prefix[index++]); return; }
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); finish(); controller.close(); return; }
        size += value.byteLength;
        if (size > LIMITS.pdf) throw new SourceError('PDF exceeds the 100 MiB limit.', 413, 'too_large');
        controller.enqueue(value);
      } catch (error) { await reader.cancel().catch(() => {}); finish(); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason).catch(() => {}); finish(); },
  });
}
export async function acquirePdf(raw, fetcher = fetch, signal, finish = () => {}) {
  const source = sourceUrl(raw);
  const candidate = publisherPdfCandidate(source);
  let candidateError;
  if (candidate) {
    try {
      const found = await publisherFetch(new URL(candidate), source, fetcher, signal);
      return {body: await validatedPdfStream(found.response, finish), url: found.url.href,
        length: found.response.headers.has('content-encoding') ? null : found.response.headers.get('content-length')};
    } catch (error) { if (signal?.aborted) throw error; candidateError = error; }
  }
  const direct = /(?:\/document\.do|\.pdf)$/i.test(source.pathname);
  const first = await publisherFetch(source, source, fetcher, signal);
  if (['application/pdf', 'application/octet-stream', 'binary/octet-stream'].includes(mediaType(first.response))) {
    return { body: await validatedPdfStream(first.response, finish), url: first.url.href,
      length: first.response.headers.has('content-encoding') ? null : first.response.headers.get('content-length') };
  }
  if (direct || !['text/html', 'application/xhtml+xml'].includes(mediaType(first.response))) {
    await discard(first.response); throw new SourceError('Publisher did not return the expected document.', 502, 'not_pdf');
  }
  let markup = new TextDecoder().decode(await readBounded(first.response, LIMITS.html));
  const isDecisia = DECISIA_HOSTS.has(source.hostname);
  const pdfLinks = text => {
    const found = verifiedDecisiaPdf(text, first.url);
    if (found) return [found.url];
    return isDecisia ? [] : rankedPublisherPdfLinks(text, first.url).filter(url => new URL(url).origin === source.origin);
  };
  let candidates = pdfLinks(markup);
  if (isDecisia && !candidates.length) {
    const framed = new URL(source); framed.searchParams.set('iframe', 'true');
    const inner = await publisherFetch(framed, source, fetcher, signal);
    if (['text/html', 'application/xhtml+xml'].includes(mediaType(inner.response))) {
      markup = new TextDecoder().decode(await readBounded(inner.response, LIMITS.html)); candidates = pdfLinks(markup);
    } else await discard(inner.response);
  }
  let lastError;
  for (const discovered of [...new Set(candidates)].slice(0, 4)) {
    if (discovered === candidate) {
      if (candidateError?.code === 'verification_required') throw Object.assign(candidateError, { pdfUrl: discovered });
      if (candidateError) { lastError = candidateError; continue; }
    }
    try {
      const found = await publisherFetch(new URL(discovered), source, fetcher, signal);
      return { body: await validatedPdfStream(found.response, finish), url: found.url.href,
        length: found.response.headers.has('content-encoding') ? null : found.response.headers.get('content-length') };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error.code === 'verification_required') throw Object.assign(error, { pdfUrl: discovered });
      lastError = error;
    }
  }
  throw lastError || new SourceError('No original PDF download control was found at the publisher.', 404, 'pdf_not_found');
}
