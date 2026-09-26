import '../vendor/pinpointer/canlii-courts.js';
import '../vendor/pinpointer/core.js';
import { getDocument, GlobalWorkerOptions, Util, OPS } from 'pdfjs-dist/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import * as pdfLib from 'pdf-lib';
import { createSearchablePdf } from '../vendor/ocr-source/pdf-export.js';
import { cropToPdfTransform } from '../vendor/ocr-source/text-layer.js';
import { recognizePage } from './ocr.mjs';
import { assetURL } from './assets.mjs';
import { findTargets, initialMarks, key } from './domain.mjs';
import { ANNOTATION_SCHEMA, decodeAnnotationSet } from './vendor/pdf-annotations.mjs';
import { writeAuthorityAnnotations } from './vendor/annotation-writer.mjs';

export async function hash(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join(''); }
export const normalize = s => String(s).normalize('NFKC').replace(/\s+/g, ' ').trim();
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const clamp = v => Math.max(0, Math.min(1, v));
export async function openPdf(data) {
  GlobalWorkerOptions.workerSrc = assetURL('pdfWorker');
  return getDocument({ data: new Uint8Array(data).slice(), isEvalSupported: false, useSystemFonts: true }).promise;
}
function itemGeometry(item, style, viewport) {
  const t=Util.transform(viewport.transform,item.transform);
  const height=Math.hypot(t[2],t[3])||Math.abs(item.height*viewport.scale);
  if(!(height>0))return null;
  const angle=Math.atan2(t[1],t[0]),ascent=style.ascent??(style.descent?1+style.descent:.8);
  const width=Math.abs(item.width*viewport.scale),ux=Math.cos(angle),uy=Math.sin(angle),vx=Math.sin(angle),vy=-Math.cos(angle);
  const points=[[0,ascent*height],[width,ascent*height],[0,-(1-ascent)*height],[width,-(1-ascent)*height]].map(([x,y])=>[t[4]+ux*x+vx*y,t[5]+uy*x+vy*y]);
  const rect=[Math.min(...points.map(p=>p[0]))/viewport.width,Math.min(...points.map(p=>p[1]))/viewport.height,
    Math.max(...points.map(p=>p[0]))/viewport.width,Math.max(...points.map(p=>p[1]))/viewport.height].map(clamp);
  return rect[2]>rect[0]&&rect[3]>rect[1]?{rect,baseline:t[5],height}:null;
}
export function nativeLines(content, viewport, pageNumber) {
  const output=[];let active;
  // Reading indentation is rotation-free; highlight geometry stays in the visible rotated frame.
  const readingViewport=viewport.rotation?viewport.clone({rotation:0}):viewport;
  for(const item of content.items){
    if(!('str' in item))continue;
    if(!item.str.trim()){if(item.hasEOL)active=undefined;continue;}
    const style=content.styles[item.fontName]||{},physical=itemGeometry(item,style,viewport);
    const logical=readingViewport===viewport?physical:itemGeometry(item,style,readingViewport);
    if(!physical||!logical)continue;
    const {height,baseline}=logical,layoutRect=logical.rect;
    const sameLine=active&&Math.abs(active.baseline-baseline)<height*.25&&layoutRect[0]>=active.layoutRect[0]-.005&&
      (layoutRect[0]-active.layoutRect[2])*readingViewport.width<height*3;
    const run={text:item.str,rect:physical.rect,layoutRect,source:'native',pageNumber};
    if(sameLine){
      const gap=(layoutRect[0]-active.layoutRect[2])*readingViewport.width;
      active.text+=`${gap>height*.15&&!/\s$/.test(active.text)?' ':''}${item.str}`;
      active.rect=union(active.rect,physical.rect);active.layoutRect=union(active.layoutRect,layoutRect);active.runs.push(run);
    }else{active={...run,baseline,runs:[run]};output.push(active);}
    if(item.hasEOL)active=undefined;
  }
  return output;
}
async function rendered(page, scale = 2) {
  let viewport = page.getViewport({ scale });
  if (viewport.width*viewport.height > 12_000_000) viewport=page.getViewport({scale:scale*Math.sqrt(12_000_000/(viewport.width*viewport.height))});
  const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  await page.render({canvasContext:canvas.getContext('2d',{willReadFrequently:true}),viewport}).promise;
  return {canvas,viewport};
}
function hasInk(canvas) {
  const small=document.createElement('canvas');small.width=160;small.height=Math.max(1,Math.round(160*canvas.height/canvas.width));
  const ctx=small.getContext('2d',{willReadFrequently:true});ctx.drawImage(canvas,0,0,small.width,small.height);
  const p=ctx.getImageData(0,0,small.width,small.height).data;
  let dark=0;for(let i=0;i<p.length;i+=4)if(p[i]+p[i+1]+p[i+2]<630)dark++;
  small.width=small.height=1;return dark>12;
}
export function assembleText(pages) {
  const repeated=new Map();
  const runningKey = line => {
    const text = normalize(line.text);
    if (/^\s*(?:\[\d+\]|\d+[.)])\s+/.test(text)) return null;
    return /^(?:page\s+)?[-–—]?\s*\d+\s*[-–—]?$/i.test(text) ? '#page-number' : text;
  };
  for(const p of pages)for(const l of p.lines){const box=l.layoutRect||l.rect;if(box[1]<.075||box[3]>.935){const k=runningKey(l);if(k===null)continue;let set=repeated.get(k);if(!set)repeated.set(k,set=new Set());set.add(p.number);}}
  let text='';const lines=[];
  for(const page of pages){
    const xValues=page.lines.filter(l=>l.text.trim()).map(l=>(l.layoutRect||l.rect)[0]).sort((a,b)=>a-b);const left=xValues[Math.floor(xValues.length*.2)]||0;
    const firstAddress=page.lines.findIndex(l=>/^\s*(?:\[\d+\]|\d+[.)])\s+/.test(l.text));
    for(const [index,line] of page.lines.entries()){
      const box=line.layoutRect||line.rect,token=runningKey(line);
      const inRunningBand=(box[1]<.075&&(token==='#page-number'||(firstAddress>=0&&index<firstAddress)))||(box[3]>.935&&token==='#page-number');
      const running=inRunningBand&&(repeated.get(token)?.size||0)>=Math.max(2,Math.ceil(pages.length*.5));
      if(running)continue;
      const indent=Math.max(0,Math.min(12,Math.round((box[0]-left)*60)));
      const start=text.length;text+=' '.repeat(indent)+line.text+'\n';lines.push({...line,start,end:text.length-1});
    }
    text+='\n';
  }
  return {text,lines};
}
export async function inspectPdf(data, engine, progress=()=>{}, signal, expectedRecord) {
  if(data.byteLength>100*1024*1024)throw new Error('PDF exceeds the 100 MiB limit.');
  const pdf=await openPdf(data), pages=[], ocrPages=[];
  if(pdf.numPages>2000){await pdf.destroy();throw new Error('PDF exceeds the 2,000-page limit.');}
  try {
    for(let n=1;n<=pdf.numPages;n++){
      signal?.throwIfAborted();progress(`Reading page ${n} of ${pdf.numPages}`);
      const page=await pdf.getPage(n),viewport=page.getViewport({scale:1});
      const native=nativeLines(await page.getTextContent(),viewport,n);let lines=native,ocr=null;
      const useful=native.reduce((sum,l)=>sum+(l.text.match(/[\p{L}\p{N}]/gu)?.length||0),0);
      const body=native.filter(l=>l.rect[1]>.1&&l.rect[3]<.9).reduce((sum,l)=>sum+l.text.length,0);
      let hasImage=false;
      if(body<40&&useful>=60){const ops=await page.getOperatorList();hasImage=ops.fnArray.some(fn=>[OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageXObjectRepeat].includes(fn));}
      if(useful<60||(body<40&&hasImage)){
        const view=await rendered(page);
        try {
          if(hasInk(view.canvas)){
            progress(`Recognizing page ${n} of ${pdf.numPages} · Quality`);
            const recognized=await recognizePage(view.canvas,signal);
            const normalized = recognized.filter(l=>!native.some(a=>normalize(a.text)===normalize(l.text)&&Math.abs(a.rect[1]-l.y/view.viewport.height)<.04));
            ocr={lines:normalized,transform:cropToPdfTransform(view.viewport.transform,null,view.canvas.width,view.canvas.height)};
            const measured=normalized.map(l=>({text:l.text,pageNumber:n,source:'ocr',rect:[l.x/view.viewport.width,l.y/view.viewport.height,(l.x+l.width)/view.viewport.width,(l.y+l.height)/view.viewport.height].map(clamp)}));
            lines=[...native,...measured].sort((a,b)=>a.rect[1]-b.rect[1]||a.rect[0]-b.rect[0]);
          }
        }finally{view.canvas.width=view.canvas.height=1;}
      }
      pages.push({number:n,width:viewport.width,height:viewport.height,lines,ocr:!!ocr});
      ocrPages.push(ocr||{lines:[],transform:[1,0,0,1,0,0]});page.cleanup();
      if(n===1&&expectedRecord)verifyIdentity(pages,expectedRecord,engine);
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    const assembled=assembleText(pages),sourceSha256=await hash(data);
    progress('Locating requested passages');
    const structure=engine({op:'structure',input:{provider:'pdf',citation:expectedRecord?.citation||'Uploaded PDF',source_kind:'cases',text:assembled.text}});
    return {data:new Uint8Array(data),pages,ocrPages,sourceSha256,...assembled,nodes:structure.nodes};
  }finally{await pdf.destroy();}
}
export function headerIdentities(pages,engine){
  const page=pages[0];if(!page)return[];
  let text='';for(const l of page.lines){if(/^\s*(?:\[1\]|1[.)])\s/.test(l.text))break;text+=l.text+'\n';if(text.length>5000)break;}
  return engine({op:'citations',text}).matches.filter(m=>m.family==='neutral'||m.family==='canlii'||m.family==='reporter');
}
// Supreme Court publisher PDFs are the bilingual S.C.R./R.C.S. print: page one opens with a running head such as
// "[2019] 4 R.C.S. / CANADA c. VAVILOV / 653", which carries no neutral citation. Accept it only when the volume
// and first page (and the year, when the citation keeps it) equal one of the record's own S.C.R. citations.
export function scrRunningHead(pages,aliases){
  const head=(pages[0]?.lines||[]).slice(0,6).map(l=>l.text).join(' ');
  return aliases.some(alias=>{
    // The parser may keep or drop the bracketed year ("[2019] 4 SCR 653" or "4 SCR 653"); require it only when present.
    const m=/^(?:\[(\d{4})\]\s*)?(\d+)\s*(?:S\.?\s?C\.?\s?R|R\.?\s?C\.?\s?S)\.?\s+(\d+)$/i.exec(alias.trim());if(!m)return false;
    return new RegExp(`${m[1]?`\\[${m[1]}\\]\\s*`:'(?:^|\\s|\\])'}${m[2]}\\s*(?:S\\.?\\s?C\\.?\\s?R|R\\.?\\s?C\\.?\\s?S)\\b`,'i').test(head)&&new RegExp(`(?:^|\\s)${m[3]}(?:\\s|$)`).test(head);
  });
}
export function verifyIdentity(pages,record,engine){
  // Reuse Pinpointer's official English/French neutral-court correspondence.
  const identityKey = value => key(globalThis.LegalPinpointerCore.canliiUrlForCitation(value,'fr') || value);
  const identities=headerIdentities(pages,engine), accepted=new Set(record.aliases.map(identityKey));
  const own=identities.filter(i=>i.family==='neutral');
  const candidates = own.length ? own.slice(0,1) : identities;
  if(!own.length&&scrRunningHead(pages,record.aliases))return;
  if(!candidates.some(i=>accepted.has(identityKey(i.text))))throw new Error(own.length?`Wrong PDF: its opening citation is ${own[0].text}, not ${record.citation}.`:'The opening citation could not be verified. Keep this file unbound and check its first page.');
}
export function attachFindings(document,record){
  document.findings=findTargets(document,record.targets);document.marks=initialMarks(document.findings);document.undo=[];document.redo=[];
  return document;
}
export async function exportPdf(document){
  let data=document.data;
  if(document.ocrPages.some(p=>p.lines.length))data=await createSearchablePdf({pdfBytes:data,pages:document.ocrPages});
  const output=await PDFDocument.load(data,{updateMetadata:false});
  const set=decodeAnnotationSet({schemaVersion:ANNOTATION_SCHEMA,sourceSha256:document.sourceSha256,marks:document.marks});
  writeAuthorityAnnotations(pdfLib,output,set,'authorities-html');
  return output.save({updateFieldAppearances:false});
}
