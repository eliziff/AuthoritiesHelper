// Release assets and the embedding inventory belong to Legal Browser OCR.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { embeddingAssetPaths } from '../../../legal-browser-ocr/runtime-assets.js';

const vendor = path.resolve(import.meta.dirname, '../vendor'), runtime = path.join(vendor, 'runtime');
const files = { ...embeddingAssetPaths, packageNotice: 'assets/manifest.json' };

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function unpack(bytes, destination, strip = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'authorities-ocr-'));
  try {
    const archive = path.join(temporary, 'input.tar.gz');
    await fs.writeFile(archive, bytes);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/u);
    for (const entry of entries) if (entry.startsWith('/') || /[\\:\x00]/u.test(entry) || entry.split('/').includes('..'))
      throw new Error('OCR archive path escapes its package.');
    if (execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/u)
      .some(entry => !['-', 'd'].includes(entry[0]))) throw new Error('OCR archives must contain ordinary files and directories.');
    await fs.mkdir(destination, { recursive: true });
    execFileSync('tar', ['-xzf', archive, ...(strip ? ['--strip-components=1'] : []), '-C', destination]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export async function prepareBrowserOcr() {
  let archive;
  if (process.env.AUTHORITIES_OCR_RUNTIME) archive = await fs.readFile(process.env.AUTHORITIES_OCR_RUNTIME);
  else {
    const response = await fetch('https://api.github.com/repos/eliziff/legal-browser-ocr/releases/latest',
      { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Browser OCR release lookup failed (${response.status}).`);
    const asset = (await response.json()).assets.find(asset => asset.name === 'legal-browser-ocr-runtime.tar.gz');
    if (!asset || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest)) throw new Error('Browser OCR release has no verified runtime asset.');
    archive = await download(asset.browser_download_url);
    if (`sha256:${crypto.createHash('sha256').update(archive).digest('hex')}` !== asset.digest)
      throw new Error('OCR runtime checksum mismatch.');
  }
  await unpack(archive, runtime);
  await browserOcrAssets();
}

export async function browserOcrAssets() {
  const manifest = JSON.parse(await fs.readFile(path.join(runtime, files.packageNotice), 'utf8'));
  return Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => {
    const bytes = await fs.readFile(path.join(runtime, file)), expected = manifest.assets[file];
    if (name !== 'packageNotice' && (!expected || bytes.length !== expected.bytes ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== expected.sha256))
      throw new Error(`Packaged OCR asset does not match its manifest: ${file}`);
    return [name, bytes.toString('base64')];
  })));
}
/** Names this recognizer, so text recognized by another build is not reused. */
export const browserOcrKey = (assets) => crypto.createHash('sha256')
  .update(JSON.stringify(Object.entries(assets).sort())).digest('hex');

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await prepareBrowserOcr();
