import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: { contents: `export { fetch, keepLocal } from './undici.mjs';
    export { process } from './node/globals.mjs';`, resolveDir: import.meta.dirname },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  define: { __UK_CASE_LAW__: 'true', __NETWORK__: 'true' },
  plugins: [{ name: 'no-persistent-browser-cache', setup(build) {
    build.onLoad({ filter: /node[\\/]globals\.mjs$/ }, () => ({ contents: 'export const process = { env: {} };' }));
    build.onLoad({ filter: /source-pdf-cache\.mjs$/ }, () => ({ contents:
      'export const keptAnswer = async () => null, keptPdf = async () => null, keepAnswer = () => {}, keepPdf = () => {};' }));
  } }],
});
const runtime = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const realFetch = globalThis.fetch, requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  return Response.json({ results: [] });
};
try {
  await runtime.fetch('https://www.courtlistener.com/api/rest/v4/search/?q=example',
    { headers: { Authorization: 'Token independently-invented-test-token' } });
  assert.equal(requests[0].url, 'https://www.courtlistener.com/api/rest/v4/search/?q=example');
  assert.equal(requests[0].init.headers.Authorization, 'Token independently-invented-test-token');
  assert.equal(requests[0].init.credentials, 'omit');

  runtime.process.env.ALR_PROVIDER_SERVICE_URL = 'https://alr.invalid/source';
  await runtime.fetch('https://api.govinfo.gov/packages/USCOURTS-example-1/summary?api_key=invented-key');
  assert.equal(requests[1].url, 'https://alr.invalid/source');
  const lookup = JSON.parse(requests[1].init.body);
  assert.equal(lookup.token, 'invented-key');
  assert.equal(new URL(lookup.source).search, '');
  runtime.keepLocal(true);
  await assert.rejects(runtime.fetch('https://www.courtlistener.com/api/rest/v4/search/'), /only local data/u);
  assert.equal(requests.length, 2);
} finally {
  globalThis.fetch = realFetch;
}
console.log('Browser provider routing passed.');
