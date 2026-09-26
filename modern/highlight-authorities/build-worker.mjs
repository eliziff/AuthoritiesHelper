// Worker-only facade build for Cloudflare Git integration; no Rust or browser-model compilation.
import fs from 'node:fs';import path from 'node:path';import{build,transform}from'esbuild';
const root=path.resolve(import.meta.dirname,'..'),folder=import.meta.dirname,out=path.join(root,'dist/authorities');fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(folder,'vendor'),{recursive:true});
let source=fs.readFileSync(path.join(root,'vendor/beaver/backend/src/lib/legalSourcePresentation.ts'),'utf8');
source=source.replace('import { normalizeWhitespace } from "./text";','const normalizeWhitespace = (value: string) => value.replace(/\\s+/gu, " ").trim();').replace('"coadecisions.ontariocourts.ca",','"coadecisions.ontariocourts.ca",\n "decisions.courts.ns.ca",').replace('/<li\\b([^>]*)>([\\s\\S]*?)<\\/li\\s*>/giu','/<(?:li|div)\\b([^>]*\\bdocuments\\b[^>]*)>([\\s\\S]*?)<\\/(?:li|div)\\s*>/giu');
fs.writeFileSync(path.join(folder,'vendor/publisher.mjs'),'// MIT. Adapted Beaver publisher controls; see THIRD_PARTY_NOTICES.md.\n'+(await transform(source,{loader:'ts',format:'esm'})).code);
await build({entryPoints:[path.join(folder,'worker.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(out,'worker.mjs'),legalComments:'inline'});
fs.copyFileSync(path.join(folder,'wrangler.jsonc'),path.join(out,'wrangler.jsonc'));fs.copyFileSync(path.join(root,'LICENSE'),path.join(out,'LICENSE'));
console.log('Worker-only package ready in dist/authorities');
