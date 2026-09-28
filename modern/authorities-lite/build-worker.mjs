// Worker-only facade build for Cloudflare Git integration; no Rust or browser-model compilation.
import fs from 'node:fs';import path from 'node:path';import{build}from'esbuild';
const root=path.resolve(import.meta.dirname,'..'),folder=import.meta.dirname,out=path.join(root,'dist/authorities');fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(folder,'vendor'),{recursive:true});
await build({entryPoints:[path.join(folder,'worker.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(out,'worker.mjs'),legalComments:'inline'});
fs.copyFileSync(path.join(folder,'wrangler.jsonc'),path.join(out,'wrangler.jsonc'));fs.copyFileSync(path.join(root,'LICENSE'),path.join(out,'LICENSE'));
console.log('Worker-only package ready in dist/authorities');
