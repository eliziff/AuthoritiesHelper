import fs from 'node:fs';import path from 'node:path';import {build,transform} from 'esbuild';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),folder=path.join(root,'authorities-lite'),out=path.join(root,'dist','authorities-lite');
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(folder,'vendor'),{recursive:true});
const read=p=>fs.readFileSync(path.join(root,p),'utf8'),write=(p,s)=>fs.writeFileSync(path.join(folder,p),s);
write('vendor/pdf-annotations.mjs',read('vendor/beaver/shared/pdf-annotations.mjs'));
let writer=read('vendor/beaver/backend/src/lib/authoritiesAnnotations.ts');const writerStart=writer.indexOf('export function writeAuthorityAnnotations');
if(writerStart<0)throw new Error('Pinned Beaver annotation export is missing.');writer=writer.slice(writerStart);
// Highlights carry no author or comment text: Beaver's writer copied the whole quote into /Contents under author "Beaver".
const patchWriter=(from,to)=>{if(!writer.includes(from))throw new Error(`Pinned Beaver annotation writer changed: ${from}`);writer=writer.replace(from,to);};
patchWriter(/const contents = [\s\S]*?`Cited passage — \$\{mark\.label\}`;\n/u.exec(writer)?.[0]??'\0','');
patchWriter("T: pdf.PDFHexString.fromText('Beaver'), Contents: pdf.PDFHexString.fromText(contents.slice(0, 2_000)),\n","");
writer=`import {decodeAnnotationSet,quadBounds,rectToPdfQuad} from './pdf-annotations.mjs';\n${writer}`;
write('vendor/annotation-writer.mjs','// MIT. Beaver annotation writer without author or comment text; see SOURCES.json.\n'+(await transform(writer,{loader:'ts',format:'esm'})).code);
let publisher=read('vendor/beaver/backend/src/lib/legalSourcePresentation.ts').replace('import { normalizeWhitespace } from "./text";', 'const normalizeWhitespace = (value: string) => value.replace(/\\s+/gu, " ").trim();');
publisher=publisher.replace('"coadecisions.ontariocourts.ca",','"coadecisions.ontariocourts.ca",\n  "decisions.courts.ns.ca",');
// Live SCC/FC responses now use a div for the same exact documents representation control.
publisher=publisher.replace('/<li\\b([^>]*)>([\\s\\S]*?)<\\/li\\s*>/giu','/<(?:li|div)\\b([^>]*\\bdocuments\\b[^>]*)>([\\s\\S]*?)<\\/(?:li|div)\\s*>/giu');
write('vendor/publisher.mjs','// MIT. Beaver controls with explicit N.S. host and li/div representation support.\n'+(await transform(publisher,{loader:'ts',format:'esm'})).code);
const assets={};for(const [name,p]of Object.entries({structure:'authorities-lite/vendor/legal-structure.wasm',pdfWorker:'vendor/runtime/dist/pdf.worker.min.mjs',
 model:'vendor/runtime/assets/model.ort',codec:'vendor/runtime/assets/codec.json',ortMjs:'vendor/runtime/assets/ort.mjs',ortWasm:'vendor/runtime/assets/ort.wasm',
 recognitionWorker:'vendor/runtime/dist/recognition-worker.js',layoutWorker:'vendor/runtime/tesseract-layout-worker.js',layoutCore:'vendor/runtime/assets/layout-core.mjs',layoutWasm:'vendor/runtime/assets/layout-core.wasm',caseAliases:'vendor/pinpointer/canlii-case-aliases.tsv'}))assets[name]=fs.readFileSync(path.join(root,p)).toString('base64');
// Tailwind compiles the Beaver-styled interface into one inline stylesheet.
execFileSync(process.execPath,[path.join(root,'node_modules/@tailwindcss/cli/dist/index.mjs'),'-i',path.join(folder,'styles.css'),'-o',path.join(folder,'vendor/styles.css'),'--minify'],{stdio:'inherit'});
const styles=read('authorities-lite/vendor/styles.css').replaceAll('</style','<\\/style');
const app=await build({entryPoints:[path.join(folder,'app.jsx')],bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,write:false,legalComments:'inline',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const inline=app.outputFiles[0].text.replaceAll('</script','<\\/script');
const bundle=`<script>globalThis.AUTHORITIES_ASSETS=${JSON.stringify(assets)}</script><script type="module">${inline}</script>`;
const html=read('authorities-lite/index.html').replace('<!--STYLES-->',()=>styles).replace('<!--BUNDLE-->',()=>bundle);
fs.writeFileSync(path.join(out,'Authorities-lite.html'),html);
await build({entryPoints:[path.join(folder,'worker.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(out,'worker.mjs'),legalComments:'inline'});
fs.copyFileSync(path.join(folder,'wrangler.jsonc'),path.join(out,'wrangler.jsonc'));
const sources={integration:'MIT',ocr:'9ef7e597f5a544c6caaabcc7345e334c697b63dd',pinpointer:read('vendor/pinpointer-revision.txt').trim(),structure:read('vendor/structure-revision.txt').trim(),beaver:read('vendor/beaver-revision.txt').trim(),assets:Object.fromEntries(Object.entries(assets).map(([n,b])=>[n,crypto.createHash('sha256').update(Buffer.from(b,'base64')).digest('hex')]))};
fs.writeFileSync(path.join(out,'SOURCES.json'),JSON.stringify(sources,null,2));
for(const file of ['README.md','VALIDATION.md','THIRD_PARTY_NOTICES.md'])if(fs.existsSync(path.join(folder,file)))fs.copyFileSync(path.join(folder,file),path.join(out,file));
fs.copyFileSync(path.join(root,'..','LICENSE'),path.join(out,'LICENSE'));
console.log(`Built ${path.join(out,'Authorities-lite.html')} (${Buffer.byteLength(html)} bytes) plus standalone worker.mjs`);
