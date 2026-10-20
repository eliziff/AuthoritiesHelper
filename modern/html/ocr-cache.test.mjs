import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';

const source = await readFile(new URL('./ocr-cache.mjs', import.meta.url), 'utf8');
let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
async function open(context, setup) {
  const page = await context.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>OCR cache test</title>' }));
  await page.goto('http://ocr-cache.test/');
  if (setup) await page.evaluate(setup);
  await page.evaluate(async source => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { globalThis.cache = await import(url); } finally { URL.revokeObjectURL(url); }
  }, source);
  return page;
}
async function isolated(run) {
  const context = await browser.newContext();
  try { await run(context); } finally { await context.close(); }
}

test('pages survive reload, retain their geometry and stay bound to their source and model', () => isolated(async context => {
  const page = await open(context);
  await page.evaluate(async () => {
    await Promise.all(Array.from({ length: 16 }, (_, page_index) => cache.writeCachedPage('orchard:model-a', {
      page_index, width: 1224, height: 1584, lines: [{ text: `Garden path ${page_index}`, confidence: .5, bbox: [72, 80, 900, 110] }],
    })));
    await cache.writeCachedPage('orchard:model-b', { page_index: 2, lines: [{ text: 'Different model' }] });
    await cache.writeCachedPage('nursery:model-a', { page_index: 2, lines: [{ text: 'Different source' }] });
    await cache.writeCachedPage('orchard:model-a', { page_index: 2, lines: [{ text: 'Replaced page' }] });
  });
  const fresh = await open(context);
  const result = await fresh.evaluate(async () => ({
    pages: await cache.readCachedPages('orchard:model-a', [11, 2]),
    all: (await cache.readCachedPages('orchard:model-a')).length,
    otherModel: await cache.readCachedPages('orchard:model-b'),
    otherSource: await cache.readCachedPages('nursery:model-a'),
    missing: await cache.readCachedPages('missing:model-a', [2]),
  }));
  assert.equal(result.all, 16);
  assert.deepEqual(result.pages, [{ page_index: 2, lines: [{ text: 'Replaced page' }] }, {
    page_index: 11, width: 1224, height: 1584, lines: [{ text: 'Garden path 11', confidence: .5, bbox: [72, 80, 900, 110] }],
  }]);
  assert.equal(result.otherModel[0].lines[0].text, 'Different model');
  assert.equal(result.otherSource[0].lines[0].text, 'Different source');
  assert.deepEqual(result.missing, []);
}));

test('concurrent tabs keep the persistent byte budget when pages are added and replaced', () => isolated(async context => {
  const first = await open(context), second = await open(context);
  const write = (page, indices) => page.evaluate(async indices => {
    for (const page_index of indices) await cache.writeCachedPage('large-garden:model', {
      page_index, lines: [{ text: 'a'.repeat(4 * 1024 * 1024) }],
    });
  }, indices);
  await Promise.all([write(first, [0, 2, 4, 6]), write(second, [1, 3, 5, 7])]);
  await write(first, [8]);
  await first.evaluate(async () => {
    await cache.writeCachedPage('large-garden:model', { page_index: 8, lines: [{ text: 'small replacement' }] });
  });
  await write(second, [9]);
  const fresh = await open(context);
  const result = await fresh.evaluate(async () => {
    const pages = await cache.readCachedPages('large-garden:model');
    return { count: pages.length, bytes: pages.reduce((sum, page) => sum + JSON.stringify(page).length * 2, 0),
      replacement: pages.find(page => page.page_index === 8)?.lines[0].text, latest: pages.some(page => page.page_index === 9) };
  });
  assert.ok(result.count > 1 && result.count < 10);
  assert.ok(result.bytes <= 64 * 1024 * 1024);
  assert.equal(result.replacement, 'small replacement');
  assert.equal(result.latest, true);
}));

test('denied storage and aborted transactions leave recognition usable in memory', () => isolated(async context => {
  for (const setup of [
    () => Object.defineProperty(globalThis, 'indexedDB', { get() { throw new DOMException('Storage denied', 'SecurityError'); } }),
    () => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = original.apply(this, args);
        if (args[1] === 'readwrite') queueMicrotask(() => transaction.abort());
        return transaction;
      };
    },
  ]) {
    const page = await open(context, setup);
    const result = await page.evaluate(async () => {
      const value = { page_index: 1, lines: [{ text: 'The pear tree has new leaves.' }] };
      await cache.writeCachedPage('pear:model', value);
      return await cache.readCachedPages('pear:model', [1]);
    });
    assert.deepEqual(result, [{ page_index: 1, lines: [{ text: 'The pear tree has new leaves.' }] }]);
    await page.close();
  }
}));

test('the old disposable cache is replaced without retaining whole-document records', () => isolated(async context => {
  const page = await open(context, async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('authorities-browser-ocr', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('pages', { keyPath: 'key' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, transaction = db.transaction('pages', 'readwrite');
        transaction.objectStore('pages').put({ key: 'old:model', value: { pages: [{ page_index: 0 }] } });
        transaction.oncomplete = () => { db.close(); resolve(); };
      };
    });
  });
  const result = await page.evaluate(async () => {
    const old = await cache.readCachedPages('old:model');
    await cache.writeCachedPage('new:model', { page_index: 0, lines: [] });
    return { old, current: await cache.readCachedPages('new:model') };
  });
  assert.deepEqual(result, { old: [], current: [{ page_index: 0, lines: [] }] });
}));

test('a cold 150-page pass serializes and writes each OCR page once', () => isolated(async context => {
  const page = await open(context);
  const result = await page.evaluate(async () => {
    const line = 'Orchard paths have blue markers. Water the young trees before the afternoon. ';
    const pages = Array.from({ length: 150 }, (_, page_index) => ({ page_index, width: 1224, height: 1584,
      lines: Array.from({ length: 100 }, (_, index) => ({ text: `${page_index}:${index} ${line.repeat(3)}`,
        confidence: .5, bbox: [72, 30 + index * 14, 1100, 43 + index * 14] })) }));
    const put = IDBObjectStore.prototype.put, stringify = JSON.stringify;
    let writtenPages = 0, serializedCharacters = 0;
    IDBObjectStore.prototype.put = function (value, ...rest) {
      writtenPages += value.value?.pages?.length ?? (value.page ? 1 : 0);
      return put.call(this, value, ...rest);
    };
    JSON.stringify = function (...args) { const result = stringify(...args); serializedCharacters += result?.length ?? 0; return result; };
    const at = performance.now();
    try {
      for (let index = 0; index < pages.length; index += 4)
        await Promise.all(pages.slice(index, index + 4).map(page => cache.writeCachedPage('orchard:model', page)));
    } finally { IDBObjectStore.prototype.put = put; JSON.stringify = stringify; }
    return { writeMs: performance.now() - at, pages: pages.length, finalCharacters: stringify(pages).length,
      writtenPages, serializedCharacters, restored: (await cache.readCachedPages('orchard:model')).length };
  });
  assert.equal(result.restored, 150);
  assert.equal(result.writtenPages, 150);
  assert.ok(result.serializedCharacters <= result.finalCharacters);
  console.log(JSON.stringify({ ocrCache: result }));
}));
