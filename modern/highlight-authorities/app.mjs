import {createEngine} from './engine.mjs';import {bytes} from './assets.mjs';
import {parseInstructions,key,targetLabel,pickDownloads,recentCanliiFiles} from './domain.mjs';
import {canliiPdf,resolveRecord,retrievePdf,download,makeZip,DEFAULT_SERVICE_URL} from './client.mjs';
import {inspectPdf,verifyIdentity,headerIdentities,attachFindings,exportPdf} from './pdf.mjs';import {makeViewer} from './viewer.mjs';
const $=id=>document.getElementById(id),records=[];let engine,busy=false,controller,activeRecord;
const notice=message=>{$('notice').textContent=message;};
const settings=()=>({url:DEFAULT_SERVICE_URL});
const filename=r=>r.citation.replace(/[^a-z0-9 ()[\]._-]/gi,'-')+'-highlighted.pdf';
const viewer=makeViewer($('viewer'),()=>renderRows());
function element(tag,text,className){const e=document.createElement(tag);if(text!=null)e.textContent=text;if(className)e.className=className;return e;}
function action(label,fn,disabled=false){const e=element('button',label);e.disabled=disabled;e.onclick=()=>Promise.resolve(fn()).catch(error=>notice(error.message));return e;}
function setStatus(record,status){record.status=status;const node=document.querySelector(`[data-id="${record.id}"] .status`);if(node)node.textContent=status;}
function completeStatus(record){const n=record.document.findings.filter(f=>f.status==='found').length,total=record.targets.length;return total?`${n} of ${total} requested passages located${n<total?' · review needed':''}`:'PDF ready · add highlights in review';}
function renderRows(){
 const list=$('records');list.replaceChildren();
 for(const record of records){
  const row=element('article',null,'record');row.dataset.id=record.id;
  const heading=element('div',null,'record-heading'),check=document.createElement('input');check.type='checkbox';check.checked=record.enabled;check.setAttribute('aria-label',`Include ${record.citation}`);check.disabled=busy;check.onchange=()=>record.enabled=check.checked;
  const title=element('div',null,'record-title');const name=key(record.name)===key(record.citation)?'':record.name;if(name)title.append(element('strong',name),' ');title.append(element('span',record.citation,'citation'));heading.append(check,title);
  const targets=element('div',null,'targets');for(const target of record.targets){const found=record.document?.findings.find(f=>JSON.stringify(f.target)===JSON.stringify(target));const mark=record.document?.marks.find(m=>m.label===targetLabel(target));const b=action(targetLabel(target),()=>openRecord(record,mark?.id),!record.document);b.className='target'+(found&&found.status!=='found'?' unresolved':'');targets.append(b);}
  const links=element('div',null,'row-actions');let pdfLink=canliiPdf(record.citation);if(!pdfLink)for(const c of record.aliases){pdfLink=canliiPdf(c);if(pdfLink)break;}
  if(pdfLink){const a=element('a','CanLII PDF ↗','ext-link');a.title='Open on CanLII (new tab)';a.href=pdfLink;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}
  if(record.sourceUrl){const a=element('a','Publisher');a.href=record.sourceUrl;a.target='_blank';a.rel='noopener noreferrer';links.append(a);}
  if(!record.document)links.append(action('Load PDF',()=>{activeRecord=record;$('pdf-files').click();},busy));
  if(record.document){links.append(action('Review',()=>openRecord(record)),action('Download',()=>saveRecord(record),busy));}
  const status=element('p',record.status,'status');row.append(heading,targets,status,links);
  row.ondragover=e=>{e.preventDefault();row.classList.add('dragover');};row.ondragleave=()=>row.classList.remove('dragover');row.ondrop=e=>{e.preventDefault();e.stopPropagation();row.classList.remove('dragover');if(!busy)upload(e.dataTransfer.files,record);};list.append(row);
 }
 $('empty').hidden=!!records.length;$('record-count').textContent=records.length?`${records.length} authorities`:'';
 $('download-all').disabled=busy||!records.some(r=>r.enabled&&r.document);$('find').disabled=busy||!records.length;
}
function setBusy(value){busy=value;$('paste').disabled=value;$('pdf-files').disabled=value;$('fetch-downloads').disabled=value;$('cancel').hidden=!value;renderRows();}
async function parse(){
 if(!engine)return;if(busy)return;
 const next=parseInstructions($('paste').value,engine);
 for(const r of next){const existing=records.find(a=>a.id===r.id);if(existing?.document){if(JSON.stringify(existing.targets)===JSON.stringify(r.targets))Object.assign(r,{document:existing.document,status:existing.status,aliases:existing.aliases,sourceUrl:existing.sourceUrl,sourceMetadata:existing.sourceMetadata});else{if(!confirm(`Changing pinpoints resets highlights for ${r.citation}. Continue?`))return;Object.assign(r,{document:existing.document,aliases:existing.aliases,sourceUrl:existing.sourceUrl});attachFindings(r.document,r);r.status=completeStatus(r);}}}
 records.splice(0,records.length,...next);renderRows();notice(next.length?'':'No complete case citations were detected.');
}
async function bind(record,data,signal){
 const doc=await inspectPdf(data,engine,s=>setStatus(record,s),signal,record);attachFindings(doc,record);record.document=doc;setStatus(record,completeStatus(record));renderRows();
}
async function find(){
 if(busy)return;controller=new AbortController();setBusy(true);notice('');
 try{
  for(const r of records.filter(r=>r.enabled&&!r.document)){
   if(controller.signal.aborted)break;
   try{setStatus(r,'Looking up source');const resolved=await resolveRecord(r,engine,controller.signal);
    if(!resolved){setStatus(r,'No A2AJ original located · load PDF');continue;}
    renderRows();setStatus(r,'Connecting to publisher');const data=await retrievePdf(r.sourceUrl,settings(),s=>setStatus(r,s),controller.signal);await bind(r,data,controller.signal);
   }catch(error){setStatus(r,controller.signal.aborted?'Cancelled':error.message);}
  }
 }finally{setBusy(false);controller=null;}
}
async function upload(files,explicit){
 if(busy)return;controller=new AbortController();setBusy(true);notice('');
 try{
  for(const file of Array.from(files)){
   if(controller.signal.aborted)break;if(!/\.pdf$/i.test(file.name)){notice(`${file.name}: select a PDF file.`);continue;}
   let record=explicit;
   if(!record){const name=key(file.name.replace(/(?: \(\d+\))?\.pdf$/i,''));const matches=records.filter(r=>r.aliases.some(c=>name===key(c)));if(matches.length===1)record=matches[0];}
   try{
    const data=new Uint8Array(await file.arrayBuffer());
    if(record){if(record.document&&!confirm(`Replace the PDF and highlights for ${record.citation}?`))continue;await bind(record,data,controller.signal);}
    else{
      notice(`Identifying ${file.name}`);const doc=await inspectPdf(data,engine,s=>notice(`${file.name}: ${s}`),controller.signal);
      const identities=new Set(headerIdentities(doc.pages,engine).map(m=>key(m.text)));const matches=records.filter(r=>r.aliases.some(c=>identities.has(key(c))));
      if(matches.length!==1)throw new Error('No unique matching authority. Use Load PDF on its row after checking the citation.');
      record=matches[0];verifyIdentity(doc.pages,record,engine);if(record.document&&!confirm(`Replace ${record.citation} and its highlights?`))continue;attachFindings(doc,record);record.document=doc;setStatus(record,completeStatus(record));renderRows();notice('');
    }
   }catch(error){notice(`${file.name}: ${error.message}`);if(record)setStatus(record,error.message);}
  }
 }finally{activeRecord=null;$('pdf-files').value='';setBusy(false);controller=null;}
}
async function openRecord(record,mark){if(!record.document)return;activeRecord=record;await viewer.open(record,mark);}
async function saveRecord(record){notice(`Preparing ${record.citation}`);const data=await exportPdf(record.document);download(data,filename(record));notice('');}
$('find').onclick=find;$('cancel').onclick=()=>controller?.abort();
let timer;$('paste').oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>parse().catch(e=>notice(e.message)),300);};$('paste').onpaste=$('paste').oninput;
$('pdf-files').onchange=()=>upload($('pdf-files').files,activeRecord);
$('drop').onclick=()=>{activeRecord=null;$('pdf-files').click();};$('drop').ondragover=e=>{e.preventDefault();$('drop').classList.add('dragover');};$('drop').ondragleave=()=>$('drop').classList.remove('dragover');$('drop').ondrop=e=>{e.preventDefault();$('drop').classList.remove('dragover');upload(e.dataTransfer.files);};
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
$('download-all').onclick=async()=>{setBusy(true);try{const files=[];for(const r of records.filter(r=>r.enabled&&r.document)){notice(`Preparing ${r.citation}`);files.push({name:filename(r),data:await exportPdf(r.document)});}download(makeZip(files),'Highlighted-authorities.zip');notice('');}catch(error){notice(error.message);}finally{setBusy(false);}};
$('viewer-download').onclick=()=>activeRecord&&saveRecord(activeRecord).catch(e=>notice(e.message));
// Auto-fetch from folder: the user picks the folder once (showDirectoryPicker in Chrome/Edge) and the app keeps watching it,
// adding each recent CanLII-named PDF as it lands until the tab closes or the button is clicked again.
// Browsers without that API get a one-time <input webkitdirectory> read.
const WATCH_INTERVAL=2000,fetchLabel=$('fetch-downloads').textContent;let watched=null,watchTimer=null,scanning=false;const seen=new Set();
function stopWatching(message){clearInterval(watchTimer);watchTimer=null;watched=null;$('fetch-downloads').textContent=fetchLabel;$('fetch-downloads').classList.remove('watching');if(message)notice(message);}
async function scanWatched(first=false){
 if(!watched||scanning||busy)return;scanning=true;
 try{
  if(await watched.queryPermission?.({mode:'read'})==='denied')return stopWatching(`Stopped watching ${watched.name}: access was withdrawn.`);
  const files=[];for await(const entry of watched.values())if(entry.kind==='file'&&/\.pdf$/i.test(entry.name))try{const file=await entry.getFile(),id=`${file.name}|${file.size}|${file.lastModified}`;if(!seen.has(id)){seen.add(id);files.push(file);}}catch{}
  if(files.length||first)await addFromFolder(files,!first);
 }catch(error){stopWatching(`Stopped watching the folder: ${error.message}`);}
 finally{scanning=false;}
}
$('fetch-downloads').onclick=async()=>{if(busy)return;
 if(watched)return stopWatching('Stopped watching the folder.');
 if(typeof window.showDirectoryPicker!=='function')return $('downloads-folder').click();
 let dir;try{dir=await window.showDirectoryPicker({id:'authorities-downloads',mode:'read',startIn:'downloads'});}catch(error){if(error?.name!=='AbortError')notice(`Could not open that folder: ${error.message}`);return;}
 watched=dir;seen.clear();$('fetch-downloads').textContent=`Watching ${dir.name} · Stop`;$('fetch-downloads').classList.add('watching');
 await scanWatched(true);if(watched===dir){watchTimer=setInterval(scanWatched,WATCH_INTERVAL);if(!$('notice').textContent)notice(`Watching ${dir.name}: CanLII PDFs saved there are added automatically.`);}};
$('downloads-folder').onchange=async()=>{const files=Array.from($('downloads-folder').files);$('downloads-folder').value='';await addFromFolder(files);};
async function addFromFolder(files,quiet=false){const picks=pickDownloads(files,records),picked=new Set(picks.map(p=>p.file));
 // Recent CanLII PDFs with no listed authority to bind to become their own entries, citation taken from the filename; bind() still runs the first-page citation check.
 const extras=[];for(const {citation,file} of recentCanliiFiles(files)){if(picked.has(file)||records.some(r=>r.aliases.some(c=>key(c)===key(citation))))continue;
  let r;try{r=parseInstructions(citation,engine)[0];}catch{}if(r&&!records.some(a=>a.id===r.id)){records.push(r);extras.push({record:r,file});}}
 if(extras.length)renderRows();const all=[...picks,...extras];
 if(!all.length)return quiet?undefined:notice('No PDF downloaded in the last day is named like a CanLII citation (e.g. 2019abqb666.pdf)'+(records.some(r=>!r.document)?' for a missing authority.':'.'));
 for(const {record,file} of all)await upload([file],record);
 for(const {record} of extras)if(!record.document)records.splice(records.indexOf(record),1);if(extras.length)renderRows();
 const added=all.filter(p=>p.record.document).length,missing=records.filter(r=>!r.document).length;
 if(added)notice(`Added ${added} PDF${added>1?'s':''} from the folder${missing?` · ${missing} still missing`:''}.`);}
try{engine=await createEngine(bytes('structure'));notice('');renderRows();if($('paste').value.trim())parse().catch(e=>notice(e.message));}catch(error){notice(`Runtime failed: ${error.message}`);}
// A documented inspection surface for reproducible browser tests; no privileged or remote operations.
globalThis.AuthoritiesApp={get records(){return records;},get engine(){return engine;},parse,exportPdf,inspectPdf};
