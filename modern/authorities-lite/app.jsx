import {useRef,useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {AlertTriangle,CheckCircle2,Circle,Download,ExternalLink,Eye,FilePlus2,FileText,FolderSearch,ArrowLeft,Globe,Highlighter,Loader2,Redo2,Settings,SquareDashed,TextSelect,Undo2,Search,Square,X} from 'lucide-react';
import {createEngine,caller} from './engine.mjs';import {bytes} from './assets.mjs';
import {parseInstructions,key,targetLabel,canliiFileCitation,captionStyleOfCause} from './domain.mjs';
import {canliiPdf,resolveRecord,retrievePdf,download,makeZip,DEFAULT_SERVICE_URL} from './client.mjs';
import {inspectPdf,inspectOpening,attachFindings,exportPdf} from './pdf.mjs';import {makeViewer} from './viewer.mjs';
import {canliiFiles,headerIdentities,headerText,matchFolderPdf} from '../../../shared/folder-pdf-match.mjs';import {publisherOpenUrl} from '../../../backend/src/lib/legalSourcePresentation.ts';
import {PdfPageNavigation} from '../../../frontend/src/app/components/shared/views/PdfPageNavigation.tsx';

// Application state lives outside React so long-running work mutates it directly; emit() re-renders.
const records=[],listeners=new Set();let version=0,engine,call,busy=false,controller,activeRecord,working=null,message='Loading the local parser…',paste='';
const emit=()=>{version++;for(const l of listeners)l();};
const notice=text=>{message=text;emit();};
const settings=()=>({url:DEFAULT_SERVICE_URL});
const filename=r=>r.citation.replace(/[^a-z0-9 ()[\]._-]/gi,'-')+'-highlighted.pdf';
let viewer;
function setStatus(record,status,failed=false){record.status=status;record.failed=failed;emit();}
function completeStatus(record){delete record.blocked;const n=record.document.findings.filter(f=>f.status==='found').length,total=record.targets.length;return record.filenameMatched?'Matched by filename; check the PDF in Review':total?`${n} of ${total} requested passages located${n<total?' · review needed':''}`:'PDF ready · add highlights in review';}
function setBusy(value){busy=value;emit();}
let pickPdfs=()=>{},pickFolder=()=>{};
async function parse(){
 if(!engine||busy)return;
 const next=parseInstructions(paste,engine);
 for(const r of next){const existing=records.find(a=>a.id===r.id);if(existing?.document){if(JSON.stringify(existing.targets)===JSON.stringify(r.targets))Object.assign(r,{document:existing.document,filenameMatched:existing.filenameMatched,status:existing.status,aliases:existing.aliases,sourceUrl:existing.sourceUrl,sourceMetadata:existing.sourceMetadata});else{if(!confirm(`Changing pinpoints resets highlights for ${r.citation}. Continue?`))return;Object.assign(r,{document:existing.document,filenameMatched:existing.filenameMatched,aliases:existing.aliases,sourceUrl:existing.sourceUrl});attachFindings(r.document,r,engine);r.status=completeStatus(r);}}}
 records.splice(0,records.length,...next,...records.filter(r=>r.manualOnly&&!next.some(n=>n.id===r.id)));notice(next.length||!paste.trim()?'':'No complete case citations were detected.');
}
async function bind(record,data,signal,options={}){
 const doc=await inspectPdf(data,engine,s=>setStatus(record,s),signal,record,options);attachFindings(doc,record,engine);record.document=doc;setStatus(record,completeStatus(record));
}
// Why a publisher's original did not come, as the page can tell; the row then opens the publisher.
const REASON={verification_required:'The publisher blocked the automatic download.',origin_denied:"Automatic downloads don't work from this page's address."};
async function find(){
 if(busy)return;controller=new AbortController();setBusy(true);notice('');
 // A publisher that blocked the download, or a service that refused this page, is not asked again in this run.
 const stopped=new Map();
 try{
  for(const r of records.filter(r=>r.enabled&&!r.document)){
   if(controller.signal.aborted)break;
   working=r;try{delete r.blocked;
    if(!r.sourceUrl){setStatus(r,'Looking up source');if(!await resolveRecord(r,engine,controller.signal)){setStatus(r,'No A2AJ original located · load PDF',true);continue;}}
    const held=stopped.get(new URL(r.sourceUrl).origin);
    if(held)throw Object.assign(new Error(held.message),{code:held.code});
    setStatus(r,'Connecting to publisher');const data=await retrievePdf(r.sourceUrl,settings(),s=>setStatus(r,s),controller.signal);await bind(r,data,controller.signal);
   }catch(error){
    // The PDF itself opens where its address is known, the decision's page otherwise; never a CAPTCHA page.
    if(REASON[error.code]&&r.sourceUrl){r.blocked={reason:REASON[error.code],url:publisherOpenUrl(r.sourceUrl,error.pdfUrl)??r.sourceUrl};stopped.set(new URL(r.sourceUrl).origin,error);}
    setStatus(r,controller.signal.aborted?'Cancelled':r.blocked?.reason||error.message,true);}
  }
 }finally{working=null;controller=null;setBusy(false);}
}
async function upload(files,explicit){
 if(busy)return;controller=new AbortController();setBusy(true);notice('');
 try{
  const keyedRecords=records.map(record=>({record,keys:new Set(record.aliases.map(c=>key(c,engine)).filter(Boolean))}));
  for(const file of Array.from(files)){
   if(controller.signal.aborted)break;if(!/\.pdf$/i.test(file.name)){notice(`${file.name}: select a PDF file.`);continue;}
   let record=explicit;
   if(!record){const filename=canliiFileCitation(file.name),name=filename?key(filename,engine):null;const matches=name?keyedRecords.filter(r=>r.keys.has(name)).map(r=>r.record):[];if(matches.length===1)record=matches[0];}
   working=record;try{
    const data=new Uint8Array(await file.arrayBuffer());
    // A PDF the user uploads is taken as given; one dropped on the list goes to the authority it opens with, or its own entry.
    if(record){if(record.document&&!confirm(`Replace the PDF and highlights for ${record.citation}?`))continue;record.filenameMatched=false;await bind(record,data,controller.signal,{verify:false});}
    else{
      notice(`Identifying ${file.name}`);const doc=await inspectPdf(data,engine,s=>notice(`${file.name}: ${s}`),controller.signal);
      const identities=new Set(headerIdentities(doc.pages,call).map(m=>m.key).filter(Boolean));const matches=keyedRecords.filter(r=>[...r.keys].some(identity=>identities.has(identity))).map(r=>r.record);
      if(matches.length===1)record=matches[0];
      else {const id='upload:'+doc.sourceSha256;record=records.find(r=>r.id===id);
        if(!record){record={id,citation:file.name.replace(/\.pdf$/i,''),name:file.name.replace(/\.pdf$/i,''),aliases:[],targets:[],enabled:true,manualOnly:true};records.push(record);}}
      if(record.document&&!confirm(`Replace ${record.citation} and its highlights?`))continue;record.filenameMatched=false;attachFindings(doc,record,engine);record.document=doc;setStatus(record,completeStatus(record));notice('');
    }
   }catch(error){notice(`${file.name}: ${error.message}`);if(record)setStatus(record,error.message,true);}
  }
 }finally{working=null;activeRecord=null;controller=null;setBusy(false);}
}
async function openRecord(record,mark,page){if(!record.document)return;activeRecord=record;await viewer.open(record,mark,page);}
async function saveRecord(record){notice(`Preparing ${record.citation}`);const data=await exportPdf(record.document);download(data,filename(record));notice('');}
async function downloadAll(){setBusy(true);try{const files=[];for(const r of records.filter(r=>r.enabled&&r.document)){notice(`Preparing ${r.citation}`);files.push({name:filename(r),data:await exportPdf(r.document)});}download(makeZip(files),'Highlighted-authorities.zip');notice('');}catch(error){notice(error.message);}finally{setBusy(false);}}

// Auto-fetch from folder: the user chooses the folder Chrome saves into once (showDirectoryPicker in Chrome/Edge). It is
// kept for the next visit, and while the tab is open each PDF saved there is matched as it lands, without OCR, and
// whenever the tab is come back to. Browsers without that API get a one-time <input webkitdirectory> read.
const WATCH_INTERVAL=2000;let watched=null,watchTimer=null,scanning=false,asked=null;const seen=new Set();
const folderStore=mode=>new Promise((resolve,reject)=>{const open=indexedDB.open('authorities-lite',1);open.onerror=()=>reject(open.error);
 open.onupgradeneeded=()=>open.result.createObjectStore('folder');open.onsuccess=()=>resolve(open.result.transaction('folder',mode).objectStore('folder'));});
const keepFolder=handle=>folderStore('readwrite').then(store=>handle?store.put(handle,'watched'):store.delete('watched')).catch(()=>{});
const keptFolder=()=>folderStore('readonly').then(store=>new Promise(resolve=>{const read=store.get('watched');read.onsuccess=()=>resolve(read.result||null);read.onerror=()=>resolve(null);}),()=>null);
// Per-viewer choice: take folder PDFs only for pasted authorities, never adding new rows.
const ONLY_LISTED='authorities-lite.only-pasted-list';
let onlyListed=(()=>{try{return localStorage.getItem(ONLY_LISTED)==='1';}catch{return false;}})();
function setOnlyListed(value){onlyListed=value;try{localStorage.setItem(ONLY_LISTED,value?'1':'0');}catch{}emit();}
function stopWatching(text){clearInterval(watchTimer);watchTimer=null;watched=null;if(text)notice(text);else emit();}
async function scanWatched(first=false){
 if(!watched||scanning||busy)return;scanning=true;
 try{
  // Chrome's access can end with the visit; the folder is then asked for again on the next click.
  const permission=await watched.queryPermission?.({mode:'read'});if(permission&&permission!=='granted'){asked=watched;return stopWatching();}
  const files=[];for await(const entry of watched.values())if(entry.kind==='file'&&/\.pdf$/i.test(entry.name))try{const file=await entry.getFile(),id=`${file.name}|${file.size}|${file.lastModified}`;if(!seen.has(id)){seen.add(id);files.push(file);}}catch{}
  if(files.length||first)await addFromFolder(files,!first);
 }catch(error){stopWatching(`Stopped watching the folder: ${error.message}`);}
 finally{scanning=false;}
}
async function watch(dir,first=true){watched=dir;asked=null;seen.clear();emit();await scanWatched(first);
 if(watched===dir){clearInterval(watchTimer);watchTimer=setInterval(scanWatched,WATCH_INTERVAL);}}
let askFolder=()=>{};
async function fetchFromFolder(){if(busy)return;
 if(watched){keepFolder(null);return stopWatching('Stopped watching the folder.');}
 if(asked)return askFolder();
 if(typeof window.showDirectoryPicker!=='function')return pickFolder();
 let dir;try{dir=await window.showDirectoryPicker({id:'authorities-downloads',mode:'read',startIn:'downloads'});}catch(error){if(error?.name!=='AbortError')notice(`Could not open that folder: ${error.message}`);return;}
 keepFolder(dir);await watch(dir);if(watched===dir&&!message)notice(`Watching ${dir.name}: PDFs saved there are added to their authorities.`);}
// Lite also adds a CanLII-named PDF for a case the list does not name, unless only the pasted list is wanted.
// Every other PDF goes to the authority still without one that the shared matcher finds it is; it never replaces a PDF.
async function addFromFolder(files,quiet=false){
 if(busy)return;controller=new AbortController();setBusy(true);let added=0;
 try{
  const extras=[];
  const known=new Set(records.flatMap(r=>r.aliases.map(c=>key(c,engine))).filter(Boolean));
  if(!onlyListed)for(const {citation} of canliiFiles(files)){const identity=key(citation,engine);if(!identity||known.has(identity))continue;
   let r;try{r=parseInstructions(citation,engine)[0];}catch{}if(r&&!records.some(a=>a.id===r.id)){extras.push(r);records.push(r);known.add(identity);}}
  for(const file of [...files].sort((a,b)=>b.lastModified-a.lastModified)){
   if(controller.signal.aborted)break;
   if(!/\.pdf$/i.test(file.name)||(file.webkitRelativePath||'').split('/').length>2||file.size>100*1024*1024)continue;
   const pending=records.filter(r=>r.enabled&&!r.document);if(!pending.length)break;
   let prepared;
   try{
    const data=new Uint8Array(await file.arrayBuffer());prepared=await inspectOpening(data);
    const match=await matchFolderPdf(file.name,prepared.pages,pending,call);if(!match)continue;
    const record=match.record;working=record;record.filenameMatched=match.method==='filename';
    const retained=prepared;prepared=null;
    await bind(record,data,controller.signal,{prepared:retained,recognize:false,verify:false});added++;
    // An authority listed by its citation alone takes the style of cause its PDF's caption prints.
    const name=record.name===record.citation&&captionStyleOfCause(headerText(record.document.pages),record,engine);if(name)record.name=name;
   }catch(error){if(!quiet)notice(`${file.name}: ${error.message}`);}
   finally{await prepared?.pdf.destroy();working=null;}
  }
  for(const r of extras)if(!r.document)records.splice(records.indexOf(r),1);
  if(added||!quiet)notice(added?`${added} PDF${added===1?'':'s'} added from the folder.`:'No unambiguous matches. You can upload any PDF manually.');
 }finally{controller=null;setBusy(false);}
}

const cx=(...c)=>c.filter(Boolean).join(' ');
const BUTTON='inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0';
const VARIANT={default:'border-gray-950 bg-gray-950 text-white hover:bg-gray-800',outline:'border-gray-300 bg-white text-gray-800 hover:bg-gray-50',ghost:'border-transparent bg-transparent text-gray-700 hover:bg-gray-100'};
const SIZE={default:'h-9 px-4 text-sm',compact:'h-8 gap-1.5 px-2.5 text-xs'};
const Button=({variant='default',size='default',className,...props})=><button type="button" className={cx(BUTTON,VARIANT[variant],SIZE[size],className)} {...props}/>;
const Card=({title,subtitle,actions,children,className})=><section aria-label={title} className={cx('rounded-xl border border-gray-300 bg-white shadow-sm',className)}>
 <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
  <div className="min-w-0"><h2 className="font-semibold text-gray-950">{title}</h2>{subtitle&&<p className="truncate text-sm text-gray-600">{subtitle}</p>}</div>
  {actions&&<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
 </div>{children}</section>;
const dropProps=(onFiles,setOver)=>({onDragOver:e=>{e.preventDefault();setOver(true);},onDragLeave:()=>setOver(false),onDrop:e=>{e.preventDefault();e.stopPropagation();setOver(false);if(!busy)onFiles(e.dataTransfer.files);}});

const LINK='inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-3.5';
function state(record){
 if(working===record)return {tone:'busy',label:'Fetching',Icon:Loader2};
 if(record.document)return record.document.findings.some(f=>f.status!=='found')&&record.targets.length?{tone:'ok',label:'PDF ready',Icon:CheckCircle2}:{tone:'ok',label:'PDF ready',Icon:CheckCircle2};
 if(record.failed)return {tone:'bad',label:'Needs PDF',Icon:AlertTriangle};
 return {tone:'idle',label:'No PDF yet',Icon:Circle};
}
const TONE={ok:'border-emerald-200 bg-emerald-50 text-emerald-800',warn:'border-emerald-200 bg-emerald-50 text-emerald-800',busy:'border-gray-200 bg-gray-100 text-gray-700',bad:'border-amber-200 bg-amber-50 text-amber-800',idle:'border-gray-200 bg-white text-gray-600'};
function Record({record}){
 const [over,setOver]=useState(false);
 const same=record.name===record.citation,st=state(record),ready=!!record.document;
 let pdfLink=canliiPdf(record.citation,engine);if(!pdfLink)for(const c of record.aliases){pdfLink=canliiPdf(c,engine);if(pdfLink)break;}
 return <article className={cx('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-l-4 px-4 py-4',ready?'border-l-emerald-500':'border-l-transparent',over&&'bg-red-50')} {...dropProps(files=>upload(files,record),setOver)}>
  <label className="inline-flex min-h-6 items-start pt-0.5"><input type="checkbox" className="size-[18px] cursor-pointer accent-gray-950 disabled:opacity-50" checked={record.enabled} disabled={busy} aria-label={`Include ${record.citation}`} onChange={e=>{record.enabled=e.target.checked;emit();}}/></label>
  <div className="min-w-0">
   <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
    <h3 className="min-w-0 text-[0.94rem] leading-6 text-gray-950">{!same&&<><span className="font-semibold">{record.name}</span>{' '}</>}<span className={same?'font-semibold':'text-gray-600'}>{record.citation}</span></h3>
    <span className={cx('inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium',TONE[st.tone])}><st.Icon className={cx('size-3.5',st.tone==='busy'&&'motion-safe:animate-spin')} aria-hidden="true"/>{st.label}</span>
   </div>
   {!!record.targets.length&&<div className="mt-2 flex flex-wrap gap-1.5">{record.targets.map((target,i)=>{
    const found=record.document?.findings.find(f=>JSON.stringify(f.target)===JSON.stringify(target));const mark=record.document?.marks.find(m=>m.label===targetLabel(target));const missing=found&&found.status!=='found';
    return <button key={i} type="button" disabled={!ready} title={ready?(found?.pdfPage?`Open PDF ${found.pdfPage} to highlight it yourself`:missing?'Not located · open to highlight it yourself':'Located · open at this passage'):'Available once the PDF is loaded'} onClick={()=>openRecord(record,mark?.id,found?.pdfPage).catch(e=>notice(e.message))}
     className={cx('inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default [&_svg]:size-3.5',
      !ready?'border-gray-200 bg-gray-50 text-gray-600':missing?'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100':'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100')}>
     {ready&&(missing?<AlertTriangle aria-hidden="true"/>:<Highlighter aria-hidden="true"/>)}{targetLabel(target)}</button>;})}</div>}
   {record.status&&record.status!=='Ready to find PDF'&&<p className={cx('mt-2 text-sm [overflow-wrap:anywhere]',record.failed?'text-amber-800':'text-gray-600')}>{record.status}</p>}
   <div className="mt-3 flex flex-wrap items-center gap-2">
    {ready?<><Button size="compact" onClick={()=>openRecord(record).catch(e=>notice(e.message))}><Eye/>Review</Button>
      <Button size="compact" variant="outline" disabled={busy} onClick={()=>saveRecord(record).catch(e=>notice(e.message))}><Download/>Download</Button></>
     :<Button size="compact" variant="outline" disabled={busy} onClick={()=>{activeRecord=record;pickPdfs();}}><FilePlus2/>Upload</Button>}
    {pdfLink&&<a href={pdfLink} target="_blank" rel="noopener noreferrer" title="Open this decision's PDF on CanLII in a new tab" className={LINK}><FileText aria-hidden="true"/>CanLII PDF<ExternalLink aria-hidden="true" className="text-gray-500"/></a>}
    {(!pdfLink||record.blocked)&&record.sourceUrl&&<a href={record.blocked?.url||record.sourceUrl} target="_blank" rel="noopener noreferrer" title={record.blocked?'Download the PDF from the publisher, then upload it here.':"Open this decision on the publisher's site in a new tab"} className={LINK}><Globe aria-hidden="true"/>{record.blocked?'Open publisher':'Source'}<ExternalLink aria-hidden="true" className="text-gray-500"/></a>}
   </div>
  </div>
 </article>;
}

// The review screen's frame; viewer.mjs owns everything inside it after this single render.
function ViewerShell(){
 const tool='inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4';
 return <section id="viewer" hidden aria-label="PDF highlight review" className="fixed inset-0 z-10 flex flex-col bg-app-background">
  <div className="flex min-h-14 flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-2 sm:px-6">
   <button id="close-viewer" type="button" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-3 focus-visible:ring-ring/50"><ArrowLeft className="size-4" aria-hidden="true"/><span className="hidden sm:inline">Authorities-lite</span></button>
   <div className="min-w-0 flex-1"><h2 id="viewer-title" className="truncate text-lg font-medium leading-tight text-gray-900"></h2><p id="viewer-citation" className="truncate text-sm text-gray-600"></p></div>
   <div id="viewer-pagination" className="order-3 w-full sm:order-none sm:w-auto"></div>
   <button id="viewer-download" type="button" className={cx(BUTTON,VARIANT.default,SIZE.default)}><Download/>Download PDF</button>
  </div>
  <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_15rem] md:grid-cols-[minmax(0,1fr)_20rem]">
   <div className="flex min-h-0 min-w-0 flex-col overflow-hidden"><div id="page-scroll" className="relative min-h-0 flex-1 overflow-auto px-6 pb-16 pt-5"><div id="page-wrap"></div></div></div>
   <aside className="flex flex-col gap-3 overflow-auto border-l border-gray-200 bg-white p-3 pb-6 md:p-4">
    <div className="viewer-tools flex items-center gap-1.5">
     <button id="selection-highlight" type="button" title="Highlight the selected text" className={tool}><TextSelect aria-hidden="true"/>Highlight text</button>
     <button id="area-highlight" type="button" aria-pressed="false" title="Draw a box highlight" className={tool}><SquareDashed aria-hidden="true"/>Box</button>
     <button id="undo" type="button" disabled aria-label="Undo" className={cx(tool,'ml-auto w-8 px-0')}><Undo2 aria-hidden="true"/></button>
     <button id="redo" type="button" disabled aria-label="Redo" className={cx(tool,'w-8 px-0')}><Redo2 aria-hidden="true"/></button>
    </div>
    <div className="flex flex-col gap-2.5 rounded-lg border border-gray-200 bg-gray-50 p-3">
     <p id="style-scope" className="text-xs font-medium text-gray-600">All highlights</p>
     <div className="flex items-center gap-2.5"><div id="swatches" className="flex flex-1 gap-1.5"></div><input id="colour" type="color" aria-label="Custom colour" title="Custom colour" className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0"/></div>
     <label className="flex items-center gap-2.5 text-xs text-gray-700">Opacity<input id="opacity" type="range" min=".1" max=".8" step=".05" className="flex-1 accent-gray-950"/><output id="opacity-value" className="w-9 text-right tabular-nums text-gray-500"></output></label>
    </div>
    <h3 id="viewer-summary" className="mt-1 text-sm font-semibold text-gray-950">Highlights</h3>
    <div id="highlight-list" className="flex flex-col gap-1.5"></div>
   </aside>
  </div>
 </section>;
}

function App(){
 useSyncExternalStore(l=>{listeners.add(l);return()=>listeners.delete(l);},()=>version);
 const pdfInput=useRef(null),folderInput=useRef(null),fetchSettings=useRef(null),folderAccess=useRef(null),timer=useRef(0),[over,setOver]=useState(false),[text,setText]=useState(paste);
 pickPdfs=()=>pdfInput.current?.click();pickFolder=()=>folderInput.current?.click();askFolder=()=>folderAccess.current?.showModal();
 const onPaste=value=>{setText(value);paste=value;clearTimeout(timer.current);timer.current=setTimeout(()=>parse().catch(e=>notice(e.message)),300);};
 const ready=records.filter(r=>r.enabled&&r.document).length;
 return <div className="min-h-dvh bg-app-background">
  <header className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:pb-4 lg:pt-5.5">
   <h1 className="truncate text-2xl font-medium leading-tight text-gray-900">Authorities-lite</h1>
   <div className="flex flex-wrap items-center gap-2">
    <Button variant="outline" disabled={busy} onClick={fetchFromFolder} aria-pressed={!!watched}
     title={watched?'Stop watching this folder':"Choose the folder Chrome saves into, such as Downloads\\Authorities; Chrome won't share Downloads itself. PDFs saved there are added to their authorities."}
     className={cx('border-gray-400',watched&&'border-brand bg-brand-soft text-brand-dark hover:bg-red-100')}>
     {watched?<><Loader2 className="motion-safe:animate-spin"/>Watching {watched.name}<Square className="fill-current"/></>:<><FolderSearch/>Auto-fetch from folder</>}</Button>
    <Button variant="outline" aria-label="Auto-fetch settings" title="Auto-fetch settings" className="w-9 border-gray-400 px-0"
     onClick={()=>fetchSettings.current?.showModal()}><Settings/></Button>
    <Button disabled={busy||!ready} onClick={downloadAll}><Download/>Download all</Button>
   </div>
  </header>
  <main className="mx-auto grid w-full max-w-6xl items-start gap-4 px-4 pb-8 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
   <div className="grid gap-3">
    <Card title="Paste a list of citations" actions={busy?<Button variant="outline" onClick={()=>controller?.abort()}><X/>Cancel</Button>
      :<Button disabled={!records.length} onClick={()=>find()}><Search/>Find PDFs & highlight</Button>}>
     <div className="grid gap-3 p-4">
      <textarea value={text} disabled={busy} aria-label="List of citations" placeholder="Paste a list of citations…" onChange={e=>onPaste(e.target.value)}
       className="min-h-72 w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2.5 text-[0.94rem] leading-relaxed text-gray-950 outline-none placeholder:text-gray-500 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"/>
      <button type="button" disabled={busy} onClick={()=>{activeRecord=null;pickPdfs();}} {...dropProps(files=>upload(files),setOver)}
       className={cx('flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50',over?'border-brand bg-brand-soft':'border-gray-300 bg-gray-50 hover:bg-gray-100')}>
       <FilePlus2 className="size-5 text-gray-500"/><span className="text-sm font-medium text-gray-900">Click or drag to add PDFs</span>
       <span className="text-xs text-gray-600">PDFs without a matching citation are added separately.</span></button>
     </div>
    </Card>
    <p role="status" aria-live="polite" className={cx('flex min-h-6 items-center gap-2 px-1 text-sm [overflow-wrap:anywhere]',busy?'font-medium text-gray-700':'text-gray-700')}>
     {busy&&<Loader2 className="size-4 shrink-0 text-red-700 motion-safe:animate-spin" aria-hidden="true"/>}{message}</p>
   </div>
   <Card title="Authorities" subtitle={records.length?`${records.filter(r=>r.document).length} of ${records.length} PDFs ready`:undefined}>
    {records.length?<div className="divide-y divide-gray-200">{records.map(r=><Record key={r.id} record={r}/>)}</div>
     :<p className="px-4 py-12 text-center text-sm text-gray-500">Paste a list of citations to see them here.</p>}
   </Card>
  </main>
  <input ref={pdfInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={e=>{const files=Array.from(e.target.files);e.target.value='';upload(files,activeRecord);}}/>
  <dialog ref={fetchSettings} aria-label="Auto-fetch settings" className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-gray-300 bg-white p-0 text-gray-950 shadow-lg backdrop:bg-gray-950/30">
   <form method="dialog" className="grid gap-4 p-4">
    <h2 className="font-semibold">Auto-fetch</h2>
    <label className="flex cursor-pointer items-center gap-2.5 text-sm"><input type="checkbox" className="size-[18px] accent-gray-950" checked={onlyListed} onChange={e=>setOnlyListed(e.target.checked)}/>Only auto-fetch cases from pasted list</label>
    <div className="flex justify-end"><Button type="submit">Done</Button></div>
   </form>
  </dialog>
  {/* Chrome asks again before a folder kept from an earlier visit is read: once, on the next click. */}
  <dialog ref={folderAccess} aria-label="Folder access" className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-gray-300 bg-white p-0 text-gray-950 shadow-lg backdrop:bg-gray-950/30">
   <form method="dialog" className="grid gap-4 p-4">
    <h2 className="font-semibold">Folder access</h2>
    <p className="text-sm leading-6 text-gray-700">Chrome asks again before Authorities-lite can watch <strong>{asked?.name}</strong>. Choose <strong>Allow on every visit</strong> so it won’t ask next time.</p>
    <div className="flex justify-end gap-2">
     <Button type="submit" variant="outline" onClick={()=>{asked=null;keepFolder(null);emit();}}>Not now</Button>
     <Button type="submit" onClick={async()=>{const dir=asked;if(dir&&await dir.requestPermission?.({mode:'read'})==='granted')watch(dir);}}>Allow access</Button>
    </div>
   </form>
  </dialog>
  <input ref={folderInput} type="file" webkitdirectory="" hidden onChange={e=>{const files=Array.from(e.target.files);e.target.value='';addFromFolder(files);}}/>
 </div>;
}

flushSync(()=>createRoot(document.getElementById('viewer-root')).render(<ViewerShell/>));
const pagination=createRoot(document.getElementById('viewer-pagination'));
viewer=makeViewer(document.getElementById('viewer'),emit,({page,count,labels})=>pagination.render(
 <PdfPageNavigation page={page} count={count} labels={labels} disabled={false} onNavigate={number=>viewer.goToPage(number)}/>));
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
document.getElementById('viewer-download').onclick=()=>activeRecord&&saveRecord(activeRecord).catch(e=>notice(e.message));
createRoot(document.getElementById('root')).render(<App/>);
try{engine=await createEngine(bytes('structure'));call=caller(engine);notice('');if(paste.trim())parse().catch(e=>notice(e.message));}catch(error){notice(`Runtime failed: ${error.message}`);}
// A folder kept from an earlier visit is watched again, or asked for on the next click.
keptFolder().then(async dir=>{if(!dir||watched)return;if(await dir.queryPermission?.({mode:'read'})==='granted')watch(dir,false);else{asked=dir;emit();}}).catch(()=>{});
window.addEventListener('focus',()=>scanWatched());
// A documented inspection surface for reproducible browser tests; no privileged or remote operations.
globalThis.AuthoritiesApp={get records(){return records;},get engine(){return engine;},parse,exportPdf,inspectPdf};
