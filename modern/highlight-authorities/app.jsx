import {useRef,useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {AlertTriangle,CheckCircle2,Circle,Download,ExternalLink,Eye,FilePlus2,FileText,FolderSearch,ArrowLeft,Globe,Highlighter,Loader2,Redo2,SquareDashed,TextSelect,Undo2,Search,Square,X} from 'lucide-react';
import {createEngine} from './engine.mjs';import {bytes} from './assets.mjs';
import {parseInstructions,key,targetLabel,pickDownloads,recentCanliiFiles} from './domain.mjs';
import {canliiPdf,resolveRecord,retrievePdf,download,makeZip,DEFAULT_SERVICE_URL} from './client.mjs';
import {inspectPdf,verifyIdentity,headerIdentities,attachFindings,exportPdf} from './pdf.mjs';import {makeViewer} from './viewer.mjs';

// Application state lives outside React so long-running work mutates it directly; emit() re-renders.
const records=[],listeners=new Set();let version=0,engine,busy=false,controller,activeRecord,working=null,message='Loading the local parser…',paste='';
const emit=()=>{version++;for(const l of listeners)l();};
const notice=text=>{message=text;emit();};
const settings=()=>({url:DEFAULT_SERVICE_URL});
const filename=r=>r.citation.replace(/[^a-z0-9 ()[\]._-]/gi,'-')+'-highlighted.pdf';
let viewer;
function setStatus(record,status,failed=false){record.status=status;record.failed=failed;emit();}
function completeStatus(record){const n=record.document.findings.filter(f=>f.status==='found').length,total=record.targets.length;return total?`${n} of ${total} requested passages located${n<total?' · review needed':''}`:'PDF ready · add highlights in review';}
function setBusy(value){busy=value;emit();}
let pickPdfs=()=>{},pickFolder=()=>{};
async function parse(){
 if(!engine||busy)return;
 const next=parseInstructions(paste,engine);
 for(const r of next){const existing=records.find(a=>a.id===r.id);if(existing?.document){if(JSON.stringify(existing.targets)===JSON.stringify(r.targets))Object.assign(r,{document:existing.document,status:existing.status,aliases:existing.aliases,sourceUrl:existing.sourceUrl,sourceMetadata:existing.sourceMetadata});else{if(!confirm(`Changing pinpoints resets highlights for ${r.citation}. Continue?`))return;Object.assign(r,{document:existing.document,aliases:existing.aliases,sourceUrl:existing.sourceUrl});attachFindings(r.document,r);r.status=completeStatus(r);}}}
 records.splice(0,records.length,...next);notice(next.length||!paste.trim()?'':'No complete case citations were detected.');
}
async function bind(record,data,signal){
 const doc=await inspectPdf(data,engine,s=>setStatus(record,s),signal,record);attachFindings(doc,record);record.document=doc;setStatus(record,completeStatus(record));
}
async function find(){
 if(busy)return;controller=new AbortController();setBusy(true);notice('');
 try{
  for(const r of records.filter(r=>r.enabled&&!r.document)){
   if(controller.signal.aborted)break;
   working=r;try{setStatus(r,'Looking up source');const resolved=await resolveRecord(r,engine,controller.signal);
    if(!resolved){setStatus(r,'No A2AJ original located · load PDF',true);continue;}
    setStatus(r,'Connecting to publisher');const data=await retrievePdf(r.sourceUrl,settings(),s=>setStatus(r,s),controller.signal);await bind(r,data,controller.signal);
   }catch(error){setStatus(r,controller.signal.aborted?'Cancelled':error.message,true);}
  }
 }finally{working=null;controller=null;setBusy(false);}
}
async function upload(files,explicit){
 if(busy)return;controller=new AbortController();setBusy(true);notice('');
 try{
  for(const file of Array.from(files)){
   if(controller.signal.aborted)break;if(!/\.pdf$/i.test(file.name)){notice(`${file.name}: select a PDF file.`);continue;}
   let record=explicit;
   if(!record){const name=key(file.name.replace(/(?: \(\d+\))?\.pdf$/i,''));const matches=records.filter(r=>r.aliases.some(c=>name===key(c)));if(matches.length===1)record=matches[0];}
   working=record;try{
    const data=new Uint8Array(await file.arrayBuffer());
    if(record){if(record.document&&!confirm(`Replace the PDF and highlights for ${record.citation}?`))continue;await bind(record,data,controller.signal);}
    else{
      notice(`Identifying ${file.name}`);const doc=await inspectPdf(data,engine,s=>notice(`${file.name}: ${s}`),controller.signal);
      const identities=new Set(headerIdentities(doc.pages,engine).map(m=>key(m.text)));const matches=records.filter(r=>r.aliases.some(c=>identities.has(key(c))));
      if(matches.length!==1)throw new Error('No unique matching authority. Use Load PDF on its row after checking the citation.');
      record=matches[0];verifyIdentity(doc.pages,record,engine);if(record.document&&!confirm(`Replace ${record.citation} and its highlights?`))continue;attachFindings(doc,record);record.document=doc;setStatus(record,completeStatus(record));notice('');
    }
   }catch(error){notice(`${file.name}: ${error.message}`);if(record)setStatus(record,error.message,true);}
  }
 }finally{working=null;activeRecord=null;controller=null;setBusy(false);}
}
async function openRecord(record,mark){if(!record.document)return;activeRecord=record;await viewer.open(record,mark);}
async function saveRecord(record){notice(`Preparing ${record.citation}`);const data=await exportPdf(record.document);download(data,filename(record));notice('');}
async function downloadAll(){setBusy(true);try{const files=[];for(const r of records.filter(r=>r.enabled&&r.document)){notice(`Preparing ${r.citation}`);files.push({name:filename(r),data:await exportPdf(r.document)});}download(makeZip(files),'Highlighted-authorities.zip');notice('');}catch(error){notice(error.message);}finally{setBusy(false);}}

// Auto-fetch from folder: the user picks the folder once (showDirectoryPicker in Chrome/Edge) and the app keeps watching it,
// adding each recent CanLII-named PDF as it lands until the tab closes or the button is clicked again.
// Browsers without that API get a one-time <input webkitdirectory> read.
const WATCH_INTERVAL=2000;let watched=null,watchTimer=null,scanning=false;const seen=new Set();
function stopWatching(text){clearInterval(watchTimer);watchTimer=null;watched=null;if(text)notice(text);else emit();}
async function scanWatched(first=false){
 if(!watched||scanning||busy)return;scanning=true;
 try{
  if(await watched.queryPermission?.({mode:'read'})==='denied')return stopWatching(`Stopped watching ${watched.name}: access was withdrawn.`);
  const files=[];for await(const entry of watched.values())if(entry.kind==='file'&&/\.pdf$/i.test(entry.name))try{const file=await entry.getFile(),id=`${file.name}|${file.size}|${file.lastModified}`;if(!seen.has(id)){seen.add(id);files.push(file);}}catch{}
  if(files.length||first)await addFromFolder(files,!first);
 }catch(error){stopWatching(`Stopped watching the folder: ${error.message}`);}
 finally{scanning=false;}
}
async function fetchFromFolder(){if(busy)return;
 if(watched)return stopWatching('Stopped watching the folder.');
 if(typeof window.showDirectoryPicker!=='function')return pickFolder();
 let dir;try{dir=await window.showDirectoryPicker({id:'authorities-downloads',mode:'read',startIn:'downloads'});}catch(error){if(error?.name!=='AbortError')notice(`Could not open that folder: ${error.message}`);return;}
 watched=dir;seen.clear();emit();
 await scanWatched(true);if(watched===dir){watchTimer=setInterval(scanWatched,WATCH_INTERVAL);if(!message)notice(`Watching ${dir.name}: CanLII PDFs saved there are added automatically.`);}}
async function addFromFolder(files,quiet=false){const picks=pickDownloads(files,records),picked=new Set(picks.map(p=>p.file));
 // Recent CanLII PDFs with no listed authority to bind to become their own entries, citation taken from the filename; bind() still runs the first-page citation check.
 const extras=[];for(const {citation,file} of recentCanliiFiles(files)){if(picked.has(file)||records.some(r=>r.aliases.some(c=>key(c)===key(citation))))continue;
  let r;try{r=parseInstructions(citation,engine)[0];}catch{}if(r&&!records.some(a=>a.id===r.id)){records.push(r);extras.push({record:r,file});}}
 if(extras.length)emit();const all=[...picks,...extras];
 if(!all.length)return quiet?undefined:notice('No PDF downloaded in the last day is named like a CanLII citation (e.g. 2019abqb666.pdf)'+(records.some(r=>!r.document)?' for a missing authority.':'.'));
 for(const {record,file} of all)await upload([file],record);
 for(const {record} of extras)if(!record.document)records.splice(records.indexOf(record),1);if(extras.length)emit();
 const added=all.filter(p=>p.record.document).length,missing=records.filter(r=>!r.document).length;
 if(added)notice(`Added ${added} PDF${added>1?'s':''} from the folder${missing?` · ${missing} still missing`:''}.`);}

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
 const same=key(record.name)===key(record.citation),st=state(record),ready=!!record.document;
 let pdfLink=canliiPdf(record.citation);if(!pdfLink)for(const c of record.aliases){pdfLink=canliiPdf(c);if(pdfLink)break;}
 return <article className={cx('grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-l-4 px-4 py-4',ready?'border-l-emerald-500':'border-l-transparent',over&&'bg-red-50')} {...dropProps(files=>upload(files,record),setOver)}>
  <label className="inline-flex min-h-6 items-start pt-0.5"><input type="checkbox" className="size-[18px] cursor-pointer accent-gray-950 disabled:opacity-50" checked={record.enabled} disabled={busy} aria-label={`Include ${record.citation}`} onChange={e=>{record.enabled=e.target.checked;emit();}}/></label>
  <div className="min-w-0">
   <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
    <h3 className="min-w-0 text-[0.94rem] leading-6 text-gray-950">{!same&&<><span className="font-semibold">{record.name}</span>{' '}</>}<span className={same?'font-semibold':'text-gray-600'}>{record.citation}</span></h3>
    <span className={cx('inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium',TONE[st.tone])}><st.Icon className={cx('size-3.5',st.tone==='busy'&&'motion-safe:animate-spin')} aria-hidden="true"/>{st.label}</span>
   </div>
   {!!record.targets.length&&<div className="mt-2 flex flex-wrap gap-1.5">{record.targets.map((target,i)=>{
    const found=record.document?.findings.find(f=>JSON.stringify(f.target)===JSON.stringify(target));const mark=record.document?.marks.find(m=>m.label===targetLabel(target));const missing=found&&found.status!=='found';
    return <button key={i} type="button" disabled={!ready} title={ready?(missing?'Not located · open to highlight it yourself':'Located · open at this passage'):'Available once the PDF is loaded'} onClick={()=>openRecord(record,mark?.id).catch(e=>notice(e.message))}
     className={cx('inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default [&_svg]:size-3.5',
      !ready?'border-gray-200 bg-gray-50 text-gray-600':missing?'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100':'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100')}>
     {ready&&(missing?<AlertTriangle aria-hidden="true"/>:<Highlighter aria-hidden="true"/>)}{targetLabel(target)}</button>;})}</div>}
   {record.status&&record.status!=='Ready to find PDF'&&<p className={cx('mt-2 text-sm [overflow-wrap:anywhere]',record.failed?'text-amber-800':'text-gray-600')}>{record.status}</p>}
   <div className="mt-3 flex flex-wrap items-center gap-2">
    {ready?<><Button size="compact" onClick={()=>openRecord(record).catch(e=>notice(e.message))}><Eye/>Review</Button>
      <Button size="compact" variant="outline" disabled={busy} onClick={()=>saveRecord(record).catch(e=>notice(e.message))}><Download/>Download</Button></>
     :<Button size="compact" variant="outline" disabled={busy} onClick={()=>{activeRecord=record;pickPdfs();}}><FilePlus2/>Load PDF</Button>}
    {pdfLink&&<a href={pdfLink} target="_blank" rel="noopener noreferrer" title="Open this decision's PDF on CanLII in a new tab" className={LINK}><FileText aria-hidden="true"/>CanLII PDF<ExternalLink aria-hidden="true" className="text-gray-500"/></a>}
    {!pdfLink&&record.sourceUrl&&<a href={record.sourceUrl} target="_blank" rel="noopener noreferrer" title="Open this decision on the publisher's site in a new tab" className={LINK}><Globe aria-hidden="true"/>Source<ExternalLink aria-hidden="true" className="text-gray-500"/></a>}
   </div>
  </div>
 </article>;
}

// The review screen's frame; viewer.mjs owns everything inside it after this single render.
function ViewerShell(){
 const tool='inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4';
 return <section id="viewer" hidden aria-label="PDF highlight review" className="fixed inset-0 z-10 flex flex-col bg-app-background">
  <div className="flex min-h-14 items-center gap-3 border-b border-gray-200 bg-white px-4 py-2 sm:px-6">
   <button id="close-viewer" type="button" className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-3 focus-visible:ring-ring/50"><ArrowLeft className="size-4" aria-hidden="true"/><span className="hidden sm:inline">Authorities</span></button>
   <div className="min-w-0 flex-1"><h2 id="viewer-title" className="truncate text-lg font-medium leading-tight text-gray-900"></h2><p id="viewer-citation" className="truncate text-sm text-gray-600"></p></div>
   <label className="hidden items-center gap-1.5 whitespace-nowrap text-sm text-gray-600 md:flex">Page<input id="page-number" type="number" min="1" defaultValue="1" aria-label="Go to page" className="h-8 w-16 rounded-md border border-gray-300 bg-white px-2 text-right text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"/><span id="page-count"></span></label>
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
 const pdfInput=useRef(null),folderInput=useRef(null),timer=useRef(0),[over,setOver]=useState(false),[text,setText]=useState(paste);
 pickPdfs=()=>pdfInput.current?.click();pickFolder=()=>folderInput.current?.click();
 const onPaste=value=>{setText(value);paste=value;clearTimeout(timer.current);timer.current=setTimeout(()=>parse().catch(e=>notice(e.message)),300);};
 const ready=records.filter(r=>r.enabled&&r.document).length;
 return <div className="min-h-dvh bg-app-background">
  <header className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6 lg:pb-4 lg:pt-5.5">
   <h1 className="truncate text-2xl font-medium leading-tight text-gray-900">Authorities</h1>
   <div className="flex flex-wrap items-center gap-2">
    <Button variant="outline" disabled={busy} onClick={fetchFromFolder} aria-pressed={!!watched}
     title={watched?'Stop watching this folder':'Choose a folder once; PDFs named like 2019abqb666.pdf that are saved there are added to their authorities as they arrive.'}
     className={cx('border-gray-400',watched&&'border-brand bg-brand-soft text-brand-dark hover:bg-red-100')}>
     {watched?<><Loader2 className="motion-safe:animate-spin"/>Watching {watched.name}<Square className="fill-current"/></>:<><FolderSearch/>Auto-fetch from folder</>}</Button>
    <Button disabled={busy||!ready} onClick={downloadAll}><Download/>Download all</Button>
   </div>
  </header>
  <main className="mx-auto grid w-full max-w-6xl items-start gap-4 px-4 pb-8 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
   <div className="grid gap-3">
    <Card title="Paste a list of citations" actions={busy?<Button variant="outline" onClick={()=>controller?.abort()}><X/>Cancel</Button>
      :<Button disabled={!records.length} onClick={find}><Search/>Find PDFs & highlight</Button>}>
     <div className="grid gap-3 p-4">
      <textarea value={text} disabled={busy} aria-label="List of citations" placeholder="Paste a list of citations…" onChange={e=>onPaste(e.target.value)}
       className="min-h-72 w-full resize-y rounded-md border border-gray-300 bg-white px-3 py-2.5 text-[0.94rem] leading-relaxed text-gray-950 outline-none placeholder:text-gray-500 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60"/>
      <button type="button" disabled={busy} onClick={()=>{activeRecord=null;pickPdfs();}} {...dropProps(files=>upload(files),setOver)}
       className={cx('flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50',over?'border-brand bg-brand-soft':'border-gray-300 bg-gray-50 hover:bg-gray-100')}>
       <FilePlus2 className="size-5 text-gray-500"/><span className="text-sm font-medium text-gray-900">Click or drag to add PDFs</span>
       <span className="text-xs text-gray-600">Each PDF is matched to its citation.</span></button>
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
  <input ref={folderInput} type="file" webkitdirectory="" hidden onChange={e=>{const files=Array.from(e.target.files);e.target.value='';addFromFolder(files);}}/>
 </div>;
}

flushSync(()=>createRoot(document.getElementById('viewer-root')).render(<ViewerShell/>));viewer=makeViewer(document.getElementById('viewer'),emit);
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
document.getElementById('viewer-download').onclick=()=>activeRecord&&saveRecord(activeRecord).catch(e=>notice(e.message));
createRoot(document.getElementById('root')).render(<App/>);
try{engine=await createEngine(bytes('structure'));notice('');if(paste.trim())parse().catch(e=>notice(e.message));}catch(error){notice(`Runtime failed: ${error.message}`);}
// A documented inspection surface for reproducible browser tests; no privileged or remote operations.
globalThis.AuthoritiesApp={get records(){return records;},get engine(){return engine;},parse,exportPdf,inspectPdf};
