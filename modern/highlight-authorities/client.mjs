import '../vendor/pinpointer/canlii-courts.js';
import '../vendor/pinpointer/core.js';
import { key } from './domain.mjs';
import { acquirePdf, readBounded, LIMITS } from './network.mjs';
import { textAsset } from './assets.mjs';
const core = globalThis.LegalPinpointerCore;
export const DEFAULT_SERVICE_URL = 'https://quiet-wildflower-ab0d.eliziffprofessional.workers.dev/';
let aliases;
export function aliasTarget(citation) {
  if (!aliases) aliases = new Map(textAsset('caseAliases').split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => l.split('\t')));
  return aliases.get(core.citationKey(citation));
}
export function canliiPdf(citation) {
  const target = aliasTarget(citation);
  const page = core.canliiUrlForCitation(citation) || (target ? core.canliiUrlForAliasTarget(target) : null);
  return page ? page.replace(/\.html(?:#.*)?$/, '.pdf') : null;
}
export function serviceURL(raw, path = '/health') {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use the HTTPS address of your Worker.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && !['/health','/pdf'].includes(url.pathname))) throw new Error('Use the Worker base address, without a path or query.');
  url.pathname = path; return url;
}
export async function checkService(raw) {
  const r = await fetch(serviceURL(raw), { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15_000) });
  const value = await r.json();
  if (!r.ok || !value.ok || value.service !== 'authorities-provider-pdf') throw new Error(value.error || 'This is not the Authorities PDF Worker.');
  return value;
}
// A browser fetch that never gets a CORS-readable response rejects with a bare TypeError ("Failed to fetch").
// Name the service and step instead, so a failure says what could not be reached.
async function reach(url, what, signal) {
  try { return await fetch(url, { credentials:'omit',referrerPolicy:'no-referrer',signal }); }
  catch (error) { if (signal?.aborted) throw error; throw new Error(`Could not reach ${what} (${url.host}). Check the connection and retry.`); }
}
async function json(r) { return JSON.parse(new TextDecoder().decode(await readBounded(r,32*1024*1024))); }
// A2AJ answers browsers with Access-Control-Allow-Origin: *, so a file:// page queries it directly.
async function lookupCase(citation, signal) {
  const url = new URL('/fetch', 'https://api.a2aj.ca');
  url.search = new URLSearchParams({ citation, doc_type:'cases', output_language:'en' });
  const r = await reach(url, 'A2AJ', signal);
  if(!r.ok)throw new Error(`A2AJ returned HTTP ${r.status}. Retry source lookup later.`);
  return json(r);
}
export async function resolveRecord(record, engine, signal) {
  const alternate = aliasTarget(record.citation);
  const candidates=[record.citation];
  if(alternate&&/^\d{4}\s/.test(alternate))candidates.push(alternate);
  const accepted=new Set(candidates.map(key));let found;
  const exact = rows => (Array.isArray(rows)?rows:[]).filter(row=>['citation_en','citation2_en','citation_fr','citation2_fr'].some(field=>{
    const text=row[field];if(!text)return false;
    if(accepted.has(key(text)))return true;
    return engine({op:'citations',text}).matches.some(m=>accepted.has(key(m.text)));
  }));
  for(const citation of candidates){
    const result=await lookupCase(citation,signal);
    const rows=exact(result.results);if(rows.length===1){found=rows[0];break;}
    if(rows.length>1)throw new Error('A2AJ returned multiple exact records. Select the correct original PDF manually.');
  }
  if(!found)return null;
  const ownCites=['citation_en','citation2_en','citation_fr','citation2_fr'].flatMap(field=>found[field]?engine({op:'citations',text:found[field]}).matches.map(m=>m.text):[]);
  const source=found.source_url_en||found.url_en||found.source_url_fr||found.url_fr;
  if(!source)return null;
  let url;try{url=new URL(source);}catch{throw new Error('A2AJ did not provide a valid publisher URL.');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('A2AJ returned an unsupported publisher address.');
  record.aliases=[...new Set([...record.aliases,...ownCites])];
  record.name=found.name_en||found.name_fr||record.name;record.sourceUrl=url.href;
  record.sourceMetadata={dataset:found.dataset,citation:found.citation_en||found.citation_fr,upstreamLicense:found.upstream_license||null};
  return record;
}
export async function retrievePdf(source,settings,progress,signal){
  let response;
  if(settings.url){
    const url=serviceURL(settings.url,'/pdf');url.searchParams.set('source',source);
    response=await reach(url,'the Authorities download service',signal);
    if(!response.ok){let error;try{error=(await response.json()).error;}catch{}throw new Error(error||`Download service returned HTTP ${response.status}.`);}
  }else{
    try{const found=await acquirePdf(source,fetch,signal);response=new Response(found.body,{headers:{'Content-Type':'application/pdf',...(found.length?{'Content-Length':found.length}:{})}});}
    catch(error){throw new Error(`Direct publisher retrieval failed. Configure the PDF service to enable server-side retrieval. ${error.message}`);}
  }
  const expected=Number(response.headers.get('Content-Length'))||0;
  if(expected>LIMITS.pdf){await response.body?.cancel();throw new Error('PDF exceeds the 100 MiB limit.');}
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>LIMITS.pdf)throw new Error('PDF exceeds the 100 MiB limit.');chunks.push(value);progress(expected?`Downloading ${Math.min(100,Math.round(100*total/expected))}%`:`Downloading ${(total/1024/1024).toFixed(1)} MB`);}}
  catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
  const data=new Uint8Array(total);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}
  if(new TextDecoder().decode(data.subarray(0,5))!=='%PDF-')throw new Error('The returned file is not a PDF.');
  return data;
}
// PDF files are already compressed. Store-only ZIP avoids a second heavyweight archive dependency.
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(data){let n=0xffffffff;for(const b of data)n=crcTable[(n^b)&255]^(n>>>8);return(n^0xffffffff)>>>0;}
export function makeZip(files){
  const parts=[],directory=[];let offset=0;const encoder=new TextEncoder();
  for(const file of files){const name=encoder.encode(file.name),data=file.data,crc=crc32(data),head=new Uint8Array(30+name.length),v=new DataView(head.buffer);
    v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x800,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);head.set(name,30);parts.push(head,data);
    const d=new Uint8Array(46+name.length),dv=new DataView(d.buffer);dv.setUint32(0,0x02014b50,true);dv.setUint16(4,20,true);dv.setUint16(6,20,true);dv.setUint16(8,0x800,true);dv.setUint32(16,crc,true);dv.setUint32(20,data.length,true);dv.setUint32(24,data.length,true);dv.setUint16(28,name.length,true);dv.setUint32(42,offset,true);d.set(name,46);directory.push(d);offset+=head.length+data.length;
  }
  const directoryLength=directory.reduce((n,d)=>n+d.length,0),end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,directoryLength,true);v.setUint32(16,offset,true);
  return new Blob([...parts,...directory,end],{type:'application/zip'});
}
export function download(value,name,type='application/pdf'){
  const blob=value instanceof Blob?value:new Blob([value],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60_000);
}
