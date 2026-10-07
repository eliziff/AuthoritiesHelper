import fs from 'node:fs';import path from 'node:path';import {build} from 'esbuild';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {withContentSecurityPolicy} from '../html/content-policy.mjs';import {DEFAULT_SERVICE_URL} from '../provider-pdf-service.mjs';
const root=path.resolve(import.meta.dirname,'..'),folder=path.join(root,'authorities-lite'),out=path.join(root,'dist','authorities-lite');
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(folder,'vendor'),{recursive:true});
const beaver=path.resolve(root,'../..');
const pinpointer=path.resolve(process.env.LEGAL_PINPOINTER_ROOT||path.join(beaver,'legal-pinpointer'));
const engine=path.join(folder,'vendor/legal-structure.wasm');
if(!fs.existsSync(engine)||!fs.existsSync(path.join(folder,'vendor/legal-structure.js')))throw new Error('Browser engine missing. Run node html/build-engine.mjs --lite from modern first.');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const assets={};for(const [name,p]of Object.entries({structure:'authorities-lite/vendor/legal-structure.wasm',pdfWorker:'vendor/runtime/dist/pdf.worker.min.mjs',
 model:'vendor/runtime/assets/model.ort',codec:'vendor/runtime/assets/codec.json',ortMjs:'browser-ocr/wasm/ort.mjs',ortWasm:'browser-ocr/wasm/ort.wasm',
 recognitionWorker:'vendor/runtime/dist/recognition-worker.js',layoutWorker:'vendor/runtime/tesseract-layout-worker.js',layoutCore:'browser-ocr/wasm/layout-core.mjs',layoutWasm:'browser-ocr/wasm/layout-core.wasm',caseAliases:path.join(pinpointer,'canlii-case-aliases.tsv')}))assets[name]=fs.readFileSync(path.resolve(root,p)).toString('base64');
// Tailwind compiles the Beaver-styled interface into one inline stylesheet.
execFileSync(process.execPath,[path.join(root,'node_modules/@tailwindcss/cli/dist/index.mjs'),'-i',path.join(folder,'styles.css'),'-o',path.join(folder,'vendor/styles.css'),'--minify'],{stdio:'inherit'});
const styles=read('authorities-lite/vendor/styles.css').replaceAll('</style','<\\/style');
const app=await build({entryPoints:[path.join(folder,'app.jsx')],bundle:true,format:'esm',platform:'browser',target:'chrome120',minify:true,write:false,legalComments:'inline',jsx:'automatic',metafile:true,alias:{react:path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom'),'pdf-lib':path.join(root,'node_modules/pdf-lib')},define:{'process.env.NODE_ENV':'"production"'}});
const inline=app.outputFiles[0].text.replaceAll('</script','<\\/script');
const bundle=`<script>globalThis.AUTHORITIES_ASSETS=${JSON.stringify(assets)}</script><script type="module">${inline}</script>`;
// The page reaches A2AJ and the publisher PDF service alone (client.mjs).
const html=withContentSecurityPolicy(read('authorities-lite/index.html').replace('<!--STYLES-->',()=>styles).replace('<!--BUNDLE-->',()=>bundle),['https://api.a2aj.ca',new URL(DEFAULT_SERVICE_URL).origin]);
fs.writeFileSync(path.join(out,'Authorities-lite.html'),html);
const worker=await build({metafile:true,entryPoints:[path.join(folder,'worker.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:path.join(out,'worker.mjs'),legalComments:'inline'});
fs.copyFileSync(path.join(folder,'wrangler.jsonc'),path.join(out,'wrangler.jsonc'));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sources={integration:'MIT',sources:Object.fromEntries([...new Set([...Object.keys(app.metafile.inputs),...Object.keys(worker.metafile.inputs)])].sort().map(file=>[path.relative(beaver,path.resolve(file)).replaceAll('\\','/'),hash(fs.readFileSync(file))])),assets:Object.fromEntries(Object.entries(assets).map(([name,bytes])=>[name,hash(Buffer.from(bytes,'base64'))]))};
fs.writeFileSync(path.join(out,'SOURCES.json'),JSON.stringify(sources,null,2));
for(const file of ['README.md','VALIDATION.md','THIRD_PARTY_NOTICES.md'])if(fs.existsSync(path.join(folder,file)))fs.copyFileSync(path.join(folder,file),path.join(out,file));
fs.appendFileSync(path.join(out,'THIRD_PARTY_NOTICES.md'),'\n'+fs.readFileSync(path.join(beaver,'common-law-cite/crates/legal-citations/NOTICE'),'utf8'));
fs.copyFileSync(path.join(root,'..','LICENSE'),path.join(out,'LICENSE'));
console.log(`Built ${path.join(out,'Authorities-lite.html')} (${Buffer.byteLength(html)} bytes) plus standalone worker.mjs`);
