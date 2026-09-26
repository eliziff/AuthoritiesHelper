// Developer build step only. End users receive the already bundled HTML and Worker.
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),vendor=path.join(root,'vendor');
const sources=[['legal-pinpointer','pinpointer','39d85cfcd5cfd24497ba85f0654f0fae20cb44e2'],['legal-structure-parser','structure','f73bcd5d66575c0504e97fc2c3b95bf5589377e5'],['legal-browser-ocr','ocr-source','b05952bd9b8dd47c93290899c8e3142b266d85c7']];
const beaver='545631f324b2c15bcecbd925a6f512cff72857e5';
async function get(url){const response=await fetch(url,{signal:AbortSignal.timeout(90000)});if(!response.ok)throw new Error(`${response.status}: ${url}`);return new Uint8Array(await response.arrayBuffer());}
async function unpack(bytes,folder,strip=false){await fs.mkdir(folder,{recursive:true});const temp=await fs.mkdtemp(path.join(os.tmpdir(),'authorities-'));try{const file=path.join(temp,'input.tar.gz');await fs.writeFile(file,bytes);execFileSync('tar',['-xzf',file,...(strip?['--strip-components=1']:[]),'-C',folder],{stdio:'inherit'});}finally{await fs.rm(temp,{recursive:true,force:true});}}
const runtime=process.env.AUTHORITIES_OCR_RUNTIME
  ? new Uint8Array(await fs.readFile(process.env.AUTHORITIES_OCR_RUNTIME))
  : await get('https://github.com/eliziff/legal-browser-ocr/releases/download/v0.1.4/legal-browser-ocr-runtime.tar.gz');
if(crypto.createHash('sha256').update(runtime).digest('hex')!=='7db31e463e4d4ce6babe377093a103d71ef3e695e09868fb44735a02d4da138d')throw new Error('OCR runtime checksum mismatch.');
await unpack(runtime,path.join(vendor,'runtime'));
for(const[repo,name,rev]of sources){await unpack(await get(`https://codeload.github.com/eliziff/${repo}/tar.gz/${rev}`),path.join(vendor,name),true);await fs.writeFile(path.join(vendor,`${name}-revision.txt`),rev+'\n');}
await fs.writeFile(path.join(vendor,'beaver-revision.txt'),beaver+'\n');
for(const file of ['backend/src/lib/legalSourcePresentation.ts','backend/src/lib/canliiUrls.ts','backend/src/lib/authoritiesAnnotations.ts','backend/src/lib/legalSources/a2aj.ts','backend/src/lib/providerPdfLibraryBridge.ts','shared/pdf-annotations.mjs']){const target=path.join(vendor,'beaver',file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,await get(`https://raw.githubusercontent.com/eliziff/Beaver/${beaver}/${file}`));}
console.log('Pinned inputs restored. Compile authorities-lite/engine, then run npm run build:lite.');
