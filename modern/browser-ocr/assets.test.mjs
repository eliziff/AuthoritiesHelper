import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { chromium } from '@playwright/test';

const source = await readFile(new URL('./assets.mjs', import.meta.url));
const packed = await readFile(new URL('./packed-asset.mjs', import.meta.url));
test('base64 and served assets load on demand, share requests and preserve CPU/GPU bytes', async () => {
  const browser = await chromium.launch();
  try {
    for (const served of [false, true]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage(), fetched = [];
        const names = ['model', 'gpuModel', 'ortMjs', 'ortWasm', 'gpuMjs', 'gpuWasm', 'recognitionWorker', 'indraDetector', 'rasterWorker'];
        // Invented assets exercise packaging and inflation without model weights or external services.
        const raw = Object.fromEntries(names.map(name => [name, Buffer.from(`orchard asset: ${name}`)]));
        const compressed = Object.fromEntries(names.map(name => [name, gzipSync(raw[name])]));
        await page.route('**/*', async route => {
          const pathname = new URL(route.request().url()).pathname;
          if (pathname === '/assets.mjs' || pathname === '/packed-asset.mjs')
            return route.fulfill({ contentType: 'text/javascript', body: pathname === '/assets.mjs' ? source : packed });
          if (pathname.startsWith('/data/')) {
            const name = pathname.slice('/data/'.length); fetched.push(name);
            return route.fulfill({ body: compressed[name] });
          }
          return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>OCR asset test</title>' });
        });
        await page.goto('http://ocr-assets.test/');
        const metadata = { gzip: names, codec: Buffer.from('{"orchard":"codec"}').toString('base64'),
          detectorConfig: Buffer.from('{"orchard":"detector"}').toString('base64') };
        for (const name of names) metadata[name] = served ? { url: `/data/${name}` } : compressed[name].toString('base64');
        const result = await page.evaluate(async metadata => {
          globalThis.AUTHORITIES_ASSETS = metadata;
          const assets = await import('/assets.mjs');
          const text = bytes => new TextDecoder().decode(bytes);
          await assets.assetsReady(['rasterWorker']);
          const worker = await (await fetch(assets.assetURL('rasterWorker'))).text();
          const pending = name => { try { assets.assetURL(name); return false; } catch { return true; } };
          const before = pending('ortWasm') && pending('gpuWasm');
          const cpu = ['model', 'ortMjs', 'ortWasm', 'recognitionWorker', 'indraDetector'];
          await Promise.all([assets.assetsReady(cpu), assets.assetsReady(cpu)]);
          const cpuModel = text(assets.bytes('model'));
          const cpuRuntime = await (await fetch(assets.assetURL('ortWasm'))).text();
          const unusedGpu = pending('gpuWasm');
          const repeated = assets.assetURL('ortWasm') === assets.assetURL('ortWasm');
          await assets.assetsReady(['gpuModel', 'gpuMjs', 'gpuWasm']);
          return { before, unusedGpu, repeated, worker, cpuModel, cpuRuntime,
            gpuModel: text(assets.bytes('gpuModel')), gpuRuntime: await (await fetch(assets.assetURL('gpuWasm'))).text(),
            codec: JSON.parse(assets.textAsset('codec')), config: await (await fetch(assets.assetURL('detectorConfig'))).json() };
        }, metadata);
        assert.deepEqual(result, { before: true, unusedGpu: true, repeated: true,
          worker: 'orchard asset: rasterWorker', cpuModel: 'orchard asset: model', cpuRuntime: 'orchard asset: ortWasm',
          gpuModel: 'orchard asset: gpuModel', gpuRuntime: 'orchard asset: gpuWasm',
          codec: { orchard: 'codec' }, config: { orchard: 'detector' } });
        assert.deepEqual(fetched.sort(), served ? names.sort() : []);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
});
