import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
  await writeCrateLicenses(out, path.join(cache, '../crate-licenses'));
  return [shell];
}

/** The license texts of the crates a Rust binary links, from its dependency graph, and the Rust standard library's:
 *  the window's by default, or another crate's (`manifest`) into `file`. Crates at a local path are the maintainer's. */
export async function writeCrateLicenses(out, cache, { manifest = path.join(crate, 'Cargo.toml'), file = 'crate-licenses.txt' } = {}) {
  const run = (command, args) => execFileSync(command, args, { cwd: path.dirname(manifest), encoding: 'utf8', maxBuffer: 1 << 28 });
  copyFileSync(path.join(run('rustc', ['--print', 'sysroot']).trim(), 'share/doc/rust/COPYRIGHT-library.html'),
    path.join(out, 'Rust-standard-library.html'));
  const metadata = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform',
    'x86_64-pc-windows-msvc', '--manifest-path', manifest]));
  const packages = new Map(metadata.packages.map((item) => [item.id, item]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node])), linked = new Set();
  // Build dependencies only compile the icon and manifest resources; the shell itself is the maintainer's.
  const visit = (id) => { for (const dep of nodes.get(id).deps)
    if (dep.dep_kinds.some((kind) => kind.kind === null) && !linked.has(dep.pkg)) { linked.add(dep.pkg); visit(dep.pkg); } };
  visit(metadata.resolve.root);
  mkdirSync(cache, { recursive: true });
  const sections = [];
  for (const item of [...linked].map((id) => packages.get(id)).filter((item) => item.source)
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.dirname(item.manifest_path);
    let texts = readdirSync(dir).filter((name) => /^(licen[cs]e|copying|notice|copyright|unlicense)/i.test(name))
      .map((name) => readFileSync(path.join(dir, name), 'utf8'));
    if (!texts.length) {
      // Published without its license file: the repository's, at the commit the crate was published from, else the
      // standard text of each license the crate declares (SPDX's license list).
      const saved = path.join(cache, `${item.name}-${item.version}.txt`);
      if (!existsSync(saved)) {
        const vcs = path.join(dir, '.cargo_vcs_info.json');
        const sha = existsSync(vcs) ? JSON.parse(readFileSync(vcs, 'utf8')).git?.sha1 : null;
        const repository = item.repository?.replace('https://github.com/', 'https://raw.githubusercontent.com/');
        let text = null;
        for (const name of sha && repository ? ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'COPYING'] : []) {
          const response = await fetch(`${repository}/${sha}/${name}`);
          if (response.ok) { text = await response.text(); break; }
        }
        if (!text) {
          const ids = (item.license ?? '').split(/\s+(?:OR|AND|WITH)\s+|[()/]/).map((id) => id.trim()).filter(Boolean);
          const standard = [];
          for (const id of ids) {
            const response = await fetch(`https://raw.githubusercontent.com/spdx/license-list-data/main/text/${id}.txt`);
            if (!response.ok) throw new Error(`${item.name} ${item.version} carries no license file, nor is ${id} on SPDX's list (${response.status}).`);
            standard.push(await response.text());
          }
          if (!standard.length) throw new Error(`${item.name} ${item.version} carries no license file and declares no license.`);
          text = standard.join('\n\n');
        }
        writeFileSync(saved, text);
      }
      texts = [readFileSync(saved, 'utf8')];
    }
    sections.push(`${item.name} ${item.version} (${item.license}) ${item.repository ?? ''}\n\n${texts.join('\n\n')}`);
  }
  writeFileSync(path.join(out, file),`${sections.join(`\n\n${'='.repeat(80)}\n\n`)}\n`);
}
