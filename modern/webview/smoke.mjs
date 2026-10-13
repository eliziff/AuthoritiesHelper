import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { launchShell } from './launch.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const output = path.join(root, '.tmp/alr-shell-smoke');
const home = path.join(output, 'profile');
mkdirSync(output, { recursive: true });
const origin = 'https://shell-smoke.invalid';
const page = `<!doctype html><meta charset="utf-8"><title>Native host check</title>
<h1>Native host check</h1><p id="result">Checking worker requests…</p><script>
window.check = { done: false };
const previous = localStorage.getItem('visit'); localStorage.setItem('visit', 'saved');
const worker = new Worker(URL.createObjectURL(new Blob([
  'Promise.all([fetch("${origin}/bytes", { headers: { Range: "bytes=1-3" } }).then(r=>r.text()),' +
  'fetch("${origin}/echo", {method:"POST",headers:{"Content-Type":"text/plain"},body:"invented request"}).then(r=>r.text())])' +
  '.then(values=>postMessage({values})).catch(e=>postMessage({error:String(e)}))'
], { type:'text/javascript' })));
worker.onmessage = ({data}) => { window.check = {...data, previous, done:true}; worker.terminate();
document.querySelector('#result').textContent = data.error || 'Worker ranges and POST succeeded'; };
</script>`;

async function run() {
  const host = launchShell({ title: 'Native host check', origin, home,
    assets: file => readFileSync(path.resolve(import.meta.dirname, '../out/webview', file)),
    async handle(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/bytes') {
        assert.equal(request.headers.get('range'), 'bytes=1-3');
        return new Response('bcd', { status: 206, headers: { 'Content-Range': 'bytes 1-3/6' } });
      }
      if (url.pathname === '/echo') return new Response(await request.text());
      return new Response('Not found', { status: 404 });
    },
  });
  try {
    await host.ready;
    let result;
    for (let count = 0; count < 100; count++) {
      result = await host.evaluate('window.check ?? null');
      if (result?.done) break;
      await setTimeout(100);
    }
    assert.deepEqual(result?.values, ['bcd', 'invented request'], JSON.stringify(result));
    // No debugger port or HTTP listener is used by either application process.
    const listeners = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in @(${process.pid},${host.pid}) } | Select-Object -ExpandProperty LocalPort`],
      { encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(listeners, '', 'The native host must not listen on a TCP port');
    await host.capture(path.join(output, 'latest.png'));
    return result;
  } finally {
    host.close();
    await host.closed;
  }
}

try {
  await run();
  assert.equal((await run()).previous, 'saved', 'Draft/settings storage survives reopening');
  console.log('Native WebView2 worker requests, POST, reopen and zero-listener checks passed.');
} finally {
  // Only this harness profile is disposable; keep the latest screenshot for review.
  assert(home.startsWith(output + path.sep));
  rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
