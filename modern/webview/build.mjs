import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One build location whether reached through a checkout's junction or directly.
const crate = realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'shell'));
const VERSION = '1.0.4258.31';
const SHA256 = '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9';

/** Builds the native window (WebView2's loader is linked into it); returns the files the program carries. */
export async function buildShell(out, { icon } = {}) {
  const cache = path.resolve(crate, '../../out/.cache/webview2');
  mkdirSync(cache, { recursive: true }); mkdirSync(out, { recursive: true });
  const name = `microsoft.web.webview2.${VERSION}.nupkg`, archive = path.join(cache, name);
  if (!existsSync(archive)) {
    const response = await fetch(`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${VERSION}/${name}`);
    if (!response.ok) throw new Error(`WebView2 SDK download failed (${response.status}).`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== SHA256)
    throw new Error('The WebView2 SDK archive does not match the pinned SHA-256.');
  execFileSync(path.join(process.env.SystemRoot, 'System32/tar.exe'), ['-xf', name, 'LICENSE.txt', 'NOTICE.txt'], { cwd: cache });
  for (const file of ['LICENSE.txt', 'NOTICE.txt']) copyFileSync(path.join(cache, file), path.join(out, file));
  const target = path.join(crate, 'target'), cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), '.cargo');
  execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(crate, 'Cargo.toml'), '--target-dir', target], {
    cwd: crate, stdio: 'inherit', env: { ...process.env,
      WEBVIEW_SHELL_ICON: icon ? path.resolve(icon) : '',
      // Fat LTO has no use for an inherited incremental release profile.
      CARGO_PROFILE_RELEASE_INCREMENTAL: 'false',
      // Encoded: the checkout's path contains spaces.
      CARGO_ENCODED_RUSTFLAGS: ['-Ctarget-feature=+crt-static', `--remap-path-prefix=${crate}=webview-shell`,
        `--remap-path-prefix=${cargoHome}=cargo`].join('\x1f') } });
  const shell = path.join(out, 'WebViewShell.exe');
  copyFileSync(path.join(target, 'release/WebViewShell.exe'), shell);
  return [shell];
}
