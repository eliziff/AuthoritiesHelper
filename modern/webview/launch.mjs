import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** A native window over application Request/Response operations. No network listener. */
export function launchShell({ assets, title, origin, home, handle }) {
  const files = ['WebViewShell.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
  const directory = path.join(home, 'shell');
  mkdirSync(directory, { recursive: true });
  for (const file of files) {
    const bytes = Buffer.from(assets(file)), destination = path.join(directory, file);
    const hash = value => createHash('sha256').update(value).digest('hex');
    if (!existsSync(destination) || hash(readFileSync(destination)) !== hash(bytes)) writeFileSync(destination, bytes);
  }
  const child = spawn(path.join(directory, 'WebViewShell.exe'), [title, origin, path.join(home, 'webview')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const messages = createInterface({ input: child.stdout });
  const send = message => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n'); };
  const requests = new Set(), inspections = new Map();
  let sequence = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.once('error', readyReject);
  child.stdin.on('error', () => {}); // Child exit is reported by `closed` and rejects waiting inspections.
  messages.on('line', async line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type === 'ready') { readyResolve(); return; }
    if (message.type === 'inspection') {
      const waiting = inspections.get(message.id);
      inspections.delete(message.id);
      if (waiting) message.error ? waiting.reject(new Error(message.error)) : waiting.resolve(JSON.parse(message.result));
      return;
    }
    if (message.type !== 'request') return;
    const controller = new AbortController();
    requests.add(controller);
    try {
      const url = new URL(message.url);
      if (url.origin !== origin) throw new Error('The native application origin was refused.');
      const body = Buffer.from(message.body, 'base64');
      if (body.length > 132_000) throw new Error('The application request is too large.');
      const response = await handle(new Request(url, { method: message.method, headers: message.headers,
        ...body.length ? { body } : {}, signal: controller.signal }));
      send({ type: 'response', id: message.id, status: response.status, statusText: response.statusText || 'OK',
        headers: [...response.headers].map(([key, value]) => `${key}: ${value}\r\n`).join(''),
        body: Buffer.from(await response.arrayBuffer()).toString('base64') });
    } catch (error) {
      send({ type: 'response', id: message.id, status: 502, statusText: 'Application error',
        headers: 'Content-Type: text/plain\r\n', body: Buffer.from(error.message).toString('base64') });
    } finally { requests.delete(controller); }
  });
  const closed = new Promise(resolve => child.once('close', code => {
    messages.close();
    for (const controller of requests) controller.abort();
    readyReject(new Error('The native window closed before it was ready.'));
    for (const waiting of inspections.values()) waiting.reject(new Error('The native window closed.'));
    inspections.clear(); resolve(code ?? 1);
  }));
  const inspect = (type, value) => new Promise((resolve, reject) => {
    const id = ++sequence; inspections.set(id, { resolve, reject }); send({ type, id, ...value });
  });
  return { ready, closed, pid: child.pid, close: () => send({ type: 'close' }),
    evaluate: script => inspect('evaluate', { script }), capture: file => inspect('capture', { path: file }) };
}
