import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.4258.31';
const SHA256 = '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9';
const FILES = ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];

export async function buildShell(out) {
  const cache = path.resolve(here, '../out/.cache/webview2');
  mkdirSync(cache, { recursive: true }); mkdirSync(out, { recursive: true });
  const name = `microsoft.web.webview2.${VERSION}.nupkg`, archive = path.join(cache, name);
  if (!existsSync(archive)) {
    const response = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${VERSION}/${name}`);
    if (!response.ok) throw new Error(`WebView2 SDK download failed (${response.status}).`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== SHA256)
    throw new Error('The WebView2 SDK archive does not match the pinned SHA-256.');
  execFileSync(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', name,
    'lib/net462/Microsoft.Web.WebView2.Core.dll', 'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
    'runtimes/win-x64/native/WebView2Loader.dll'], { cwd: cache });
  for (const file of FILES) copyFileSync(path.join(cache,
    file === 'WebView2Loader.dll' ? 'runtimes/win-x64/native' : 'lib/net462', file), path.join(out, file));
  const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/out:' + path.join(out, 'WebViewShell.exe'),
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
    ...FILES.filter(file => file.startsWith('Microsoft.')).map(file => '/r:' + path.join(out, file)),
    path.join(here, 'Shell.cs')], { stdio: 'inherit' });
  return ['WebViewShell.exe', ...FILES].map(file => path.join(out, file));
}
