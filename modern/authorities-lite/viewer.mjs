import { TextLayer } from 'pdfjs-dist/build/pdf.mjs';
import { openPdf } from './pdf.mjs';
import { targetLabel, key } from './domain.mjs';

// A soft, translucent default that tints the passage without burying the text beneath it.
export const DEFAULT_RGB = [1, .93, .45], DEFAULT_OPACITY = .3;
const SWATCHES = [['Yellow', [1, .87, .35]], ['Green', [.55, .87, .55]], ['Blue', [.55, .78, 1]], ['Pink', [1, .66, .78]]];
const hex = rgb => '#'+rgb.map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join('');
const fromHex = v => [1,3,5].map(i=>parseInt(v.slice(i,i+2),16)/255);

// Continuous-scroll review: every page is laid out at its real size up front, pages near the viewport are
// rendered (canvas + text layer) and far ones are released, and highlights are painted on all pages.
export function makeViewer(root, onChange) {
  const $ = id => root.querySelector('#'+id);
  let record, pdf, epoch=0, pages=[], selectedId=null, drawing=false, dragging=null, styling=false, observer, resizeObserver, lastWidth=0;
  const style = { rgb: DEFAULT_RGB, opacity: DEFAULT_OPACITY };
  function updateHistory(){ $('undo').disabled=!record?.document.undo.length;$('redo').disabled=!record?.document.redo.length; }
  function snapshot(){const d=record.document;d.undo.push(structuredClone(d.marks));if(d.undo.length>40)d.undo.shift();d.redo=[];}
  function change(fn){snapshot();fn(record.document.marks);updateHistory();paint();renderSidebar();onChange(record);}
  function select(id){selectedId=id;paint();renderSidebar();}
  function rectBox(rect){return {left:rect[0]*100+'%',top:rect[1]*100+'%',width:(rect[2]-rect[0])*100+'%',height:(rect[3]-rect[1])*100+'%'};}
  function paint(){
    for(const p of pages)p.marks.replaceChildren();if(!record)return;
    for(const mark of record.document.marks)for(const fragment of mark.fragments){const p=pages[fragment.pageNumber-1];if(!p)continue;
      // Opacity applies to the group so overlapping line boxes never stack into darker bands.
      const group=document.createElement('div');group.className='mark-group';group.style.opacity=String(mark.opacity);group.dataset.mark=mark.id;
      for(const rect of fragment.rects){const block=document.createElement('div');block.className='mark'+(mark.id===selectedId?' selected':'');Object.assign(block.style,rectBox(rect));block.style.background=hex(mark.rgb);block.dataset.mark=mark.id;group.append(block);}
      p.marks.append(group);
      // The selection ring sits outside the translucent group so it stays crisp at any opacity.
      if(mark.id===selectedId&&fragment.rects.length){const r=fragment.rects,ring=document.createElement('div');ring.className='mark-ring';Object.assign(ring.style,rectBox([Math.min(...r.map(x=>x[0])),Math.min(...r.map(x=>x[1])),Math.max(...r.map(x=>x[2])),Math.max(...r.map(x=>x[3]))]));p.marks.append(ring);}
    }
  }
  function targets(){const marks=record.document.marks;return selectedId?marks.filter(m=>m.id===selectedId):marks;}
  function syncStyle(){
    const mark=record&&record.document.marks.find(m=>m.id===selectedId),shown=mark||style;
    $('colour').value=hex(shown.rgb);$('opacity').value=String(shown.opacity);$('opacity-value').textContent=Math.round(shown.opacity*100)+'%';
    $('style-scope').textContent=mark?'Selected highlight':record?.document.marks.length?'All highlights':'New highlights';
    for(const b of root.querySelectorAll('.swatch-button'))b.setAttribute('aria-pressed',String(hex(shown.rgb)===b.dataset.colour));
  }
  function renderSidebar(){
    const list=$('highlight-list');list.replaceChildren();
    const marks=[...record.document.marks].sort((a,b)=>{const pa=a.fragments[0]?.pageNumber??0,pb=b.fragments[0]?.pageNumber??0;return pa-pb||(a.fragments[0]?.rects[0]?.[1]??0)-(b.fragments[0]?.rects[0]?.[1]??0);});
    for(const mark of marks){
      const row=document.createElement('div');row.className='highlight-row'+(mark.id===selectedId?' active':'');row.dataset.mark=mark.id;
      const b=document.createElement('button');b.className='card-main';b.title=mark.excerpt||'';b.onclick=()=>jump(mark.id);
      const head=document.createElement('span');head.className='card-head';
      const dot=document.createElement('span');dot.className='card-dot';dot.style.background=hex(mark.rgb);
      const label=document.createElement('strong');label.textContent=mark.label||'Custom highlight';
      const where=document.createElement('span');where.className='card-page';const nums=[...new Set(mark.fragments.map(f=>f.pageNumber))];where.textContent=nums.length?'p. '+(nums.length>1?nums[0]+'–'+nums.at(-1):nums[0]):'';
      head.append(dot,label,where);b.append(head);
      if(mark.excerpt){const ex=document.createElement('span');ex.className='card-excerpt';ex.textContent=mark.excerpt;b.append(ex);}
      const del=document.createElement('button');del.className='card-delete';del.textContent='×';del.title='Delete highlight';del.setAttribute('aria-label',`Delete ${mark.label||'highlight'}`);
      del.onclick=()=>change(m=>{m.splice(m.findIndex(x=>x.id===mark.id),1);if(selectedId===mark.id)selectedId=null;});
      row.append(b,del);list.append(row);
    }
    for(const finding of record.document.findings||[]){if(finding.status==='found')continue;const row=document.createElement('p');row.className='warning';row.textContent=`${targetLabel(finding.target)}: ${finding.message}`;list.append(row);}
    if(!record.document.marks.length){const empty=document.createElement('p');empty.className='cards-empty';empty.textContent='No highlights yet. Select text on the page, then choose Highlight text.';list.prepend(empty);}
    $('viewer-summary').textContent=`${record.document.marks.length} highlight${record.document.marks.length===1?'':'s'}`;
    syncStyle();
  }
  function layout(){
    const width=Math.min(960,Math.max(320,$('page-scroll').clientWidth-48));lastWidth=$('page-scroll').clientWidth;
    for(const p of pages){p.scale=width/p.base.width;p.el.style.width=width+'px';p.el.style.height=p.base.height*p.scale+'px';}
  }
  function release(p){p.task?.cancel();p.text?.cancel();p.task=p.text=null;p.rendered=false;p.generation=(p.generation||0)+1;p.canvas.width=p.canvas.height=0;p.textLayer.replaceChildren();}
  async function renderPage(p){
    if(p.rendered||!pdf)return;p.rendered=true;const generation=p.generation=(p.generation||0)+1,run=epoch;
    const live=()=>run===epoch&&generation===p.generation;
    const page=await pdf.getPage(p.number);if(!live())return;
    const viewport=page.getViewport({scale:p.scale}),dpr=Math.min(2,window.devicePixelRatio||1);
    p.el.style.setProperty('--scale-factor',viewport.scale);p.el.style.setProperty('--total-scale-factor',viewport.scale);
    p.canvas.width=Math.ceil(viewport.width*dpr);p.canvas.height=Math.ceil(viewport.height*dpr);
    p.task=page.render({canvasContext:p.canvas.getContext('2d'),viewport,transform:dpr===1?null:[dpr,0,0,dpr,0,0]});
    try{await p.task.promise;}catch(error){if(error.name!=='RenderingCancelledException')throw error;return;}
    if(!live())return;
    const content=await page.getTextContent();if(!live())return;
    p.textLayer.replaceChildren();p.text=new TextLayer({textContentSource:content,container:p.textLayer,viewport});await p.text.render();if(!live())return;
    // Scans use measured OCR line bounds. Do not imply word-accurate geometry.
    const info=record.document.pages[p.number-1];
    if(info?.ocr)for(const line of info.lines.filter(l=>l.source==='ocr')){
      const span=document.createElement('span');span.textContent=line.text;span.className='ocr-line';Object.assign(span.style,rectBox(line.rect));span.style.fontSize=Math.max(4,(line.rect[3]-line.rect[1])*viewport.height)+'px';p.textLayer.append(span);
    }
  }
  function build(sizes){
    const wrap=$('page-wrap');wrap.replaceChildren();
    pages=sizes.map((base,i)=>{
      const el=document.createElement('div');el.className='pdf-page';el.dataset.page=String(i+1);
      const canvas=document.createElement('canvas'),textLayer=document.createElement('div'),marks=document.createElement('div'),draw=document.createElement('div');
      textLayer.className='textLayer';marks.className='marks';draw.className='draw-layer';el.append(canvas,textLayer,marks,draw);wrap.append(el);
      const p={number:i+1,base,el,canvas,textLayer,marks,draw,rendered:false};bindDraw(p);return p;
    });
    layout();
    observer=new IntersectionObserver(entries=>{for(const e of entries){const p=pages[Number(e.target.dataset.page)-1];if(!p)continue;if(e.isIntersecting)renderPage(p).catch(error=>console.error(error));else if(p.rendered)release(p);}},{root:$('page-scroll'),rootMargin:'1200px 0px'});
    for(const p of pages)observer.observe(p.el);
  }
  function currentPage(){
    const box=$('page-scroll').getBoundingClientRect(),mid=box.top+box.height*.35;let n=1;
    for(const p of pages){if(p.el.getBoundingClientRect().top<=mid)n=p.number;else break;}return n;
  }
  function scrollToPage(n,offset=0,smooth=false){const p=pages[n-1];if(!p)return;const scroll=$('page-scroll');
    const y=p.el.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop-16+offset;scroll.scrollTo({top:Math.max(0,y),behavior:'auto'});}
  $('page-scroll').addEventListener('scroll',()=>{if(pages.length&&document.activeElement!==$('page-number'))$('page-number').value=String(currentPage());},{passive:true});
  async function jump(id){
    const mark=record.document.marks.find(m=>m.id===id);if(!mark)return;select(id);
    const fragment=mark.fragments[0],p=pages[fragment.pageNumber-1];if(!p)return;
    const scroll=$('page-scroll'),y=p.el.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop+fragment.rects[0][1]*p.el.clientHeight;
    scroll.scrollTo({top:Math.max(0,y-120),behavior:'auto'});
  }
  function add(fragments,text=''){
    if(!fragments.length)return;const id=crypto.randomUUID();
    change(m=>m.push({id,kind:'highlight',origin:'manual',label:'Custom highlight',excerpt:text.slice(0,2000),rgb:[...style.rgb],opacity:style.opacity,fragments}));select(id);
  }
  const pageAt=(x,y)=>pages.find(p=>{const b=p.el.getBoundingClientRect();return x>=b.left&&x<=b.right&&y>=b.top&&y<=b.bottom;});
  $('selection-highlight').onpointerdown=e=>e.preventDefault();
  $('selection-highlight').onclick=()=>{
    const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return;
    const range=selection.getRangeAt(0);if(!$('page-wrap').contains(range.commonAncestorContainer))return;
    // A selection may cross pages: split its line boxes by the page each one sits on.
    const byPage=new Map;
    for(const r of range.getClientRects()){if(r.width<=1||r.height<=1)continue;const p=pageAt(r.left+r.width/2,r.top+r.height/2);if(!p)continue;const box=p.el.getBoundingClientRect();
      (byPage.get(p.number)||byPage.set(p.number,[]).get(p.number)).push([Math.max(0,(r.left-box.left)/box.width),Math.max(0,(r.top-box.top)/box.height),Math.min(1,(r.right-box.left)/box.width),Math.min(1,(r.bottom-box.top)/box.height)]);}
    const fragments=[];
    for(const [pageNumber,rects]of[...byPage].sort((a,b)=>a[0]-b[0])){
      // Merge adjacent selection runs on one line, preserving continuous bands.
      const merged=[];for(const r of rects){const last=merged.at(-1);if(last&&Math.abs(last[1]-r[1])<.006&&Math.abs(last[3]-r[3])<.01&&r[0]<=last[2]+.012)last[2]=Math.max(last[2],r[2]);else merged.push(r);}
      fragments.push({pageNumber,rects:merged});
    }
    add(fragments,selection.toString());selection.removeAllRanges();
  };
  $('area-highlight').onclick=()=>{drawing=!drawing;$('page-wrap').classList.toggle('drawing',drawing);$('area-highlight').setAttribute('aria-pressed',String(drawing));};
  function bindDraw(p){
    const point=event=>{const b=p.el.getBoundingClientRect();return[Math.max(0,Math.min(1,(event.clientX-b.left)/b.width)),Math.max(0,Math.min(1,(event.clientY-b.top)/b.height))];};
    const box=q=>[Math.min(q[0],dragging[0]),Math.min(q[1],dragging[1]),Math.max(q[0],dragging[0]),Math.max(q[1],dragging[1])];
    let draft;
    p.draw.onpointerdown=e=>{if(!drawing)return;dragging=point(e);e.currentTarget.setPointerCapture(e.pointerId);draft=document.createElement('div');draft.className='draft-mark';draft.hidden=true;p.draw.append(draft);};
    p.draw.onpointermove=e=>{if(!dragging||!draft)return;Object.assign(draft.style,rectBox(box(point(e))));draft.hidden=false;};
    p.draw.onpointerup=e=>{if(!dragging||!draft)return;const r=box(point(e));dragging=null;draft.remove();draft=null;if(r[2]-r[0]>.003&&r[3]-r[1]>.003)add([{pageNumber:p.number,rects:[r]}]);};
    p.draw.onpointercancel=()=>{dragging=null;draft?.remove();draft=null;};
  }
  // Clicking a highlight on the page selects its card; clicking elsewhere clears the selection.
  $('page-wrap').addEventListener('click',e=>{
    if(drawing||!record||!window.getSelection()?.isCollapsed)return;const p=pageAt(e.clientX,e.clientY);if(!p)return;
    const b=p.el.getBoundingClientRect(),x=(e.clientX-b.left)/b.width,y=(e.clientY-b.top)/b.height;
    const hit=[...record.document.marks].reverse().find(m=>m.fragments.some(f=>f.pageNumber===p.number&&f.rects.some(r=>x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3])));
    if((hit?.id??null)!==selectedId){select(hit?.id??null);if(hit)$('highlight-list').querySelector(`[data-mark="${CSS.escape(hit.id)}"]`)?.scrollIntoView({block:'nearest'});}
  });
  // Style edits apply live while dragging; one undo step covers the whole gesture.
  function restyle(fn){
    if(!record||!targets().length){fn(style);syncStyle();return;}
    if(!styling){snapshot();styling=true;}
    for(const mark of targets())fn(mark);fn(style);paint();syncStyle();
    for(const dot of root.querySelectorAll('.highlight-row'))dot.querySelector('.card-dot').style.background=hex(record.document.marks.find(m=>m.id===dot.dataset.mark)?.rgb||style.rgb);
  }
  function commit(){if(!styling)return;styling=false;updateHistory();onChange(record);}
  $('opacity').oninput=()=>restyle(m=>{m.opacity=Number($('opacity').value);});
  $('opacity').onchange=commit;
  $('colour').oninput=()=>restyle(m=>{m.rgb=fromHex($('colour').value);});
  $('colour').onchange=commit;
  const swatches=$('swatches');
  for(const [name,rgb]of SWATCHES){const b=document.createElement('button');b.className='swatch-button';b.type='button';b.title=name;b.setAttribute('aria-label',name);b.dataset.colour=hex(rgb);b.style.background=hex(rgb);
    b.onclick=()=>{restyle(m=>{m.rgb=[...rgb];});commit();};swatches.append(b);}
  for(const [id,from,to]of[['undo','undo','redo'],['redo','redo','undo']])$(id).onclick=()=>{const d=record.document;if(!d[from].length)return;d[to].push(structuredClone(d.marks));d.marks=d[from].pop();if(selectedId&&!d.marks.some(m=>m.id===selectedId))selectedId=null;paint();renderSidebar();updateHistory();onChange(record);};
  $('page-number').onchange=()=>{const n=Math.max(1,Math.min(pages.length,Number($('page-number').value)||1));$('page-number').value=String(n);scrollToPage(n);};
  $('page-number').onkeydown=e=>{if(e.key==='Enter')$('page-number').blur();};
  function teardown(){++epoch;observer?.disconnect();observer=null;resizeObserver?.disconnect();resizeObserver=null;for(const p of pages)release(p);pages=[];$('page-wrap').replaceChildren();}
  $('close-viewer').onclick=async()=>{teardown();root.hidden=true;if(pdf)await pdf.destroy();pdf=null;};
  return { async open(value,markId){
    teardown();if(pdf)await pdf.destroy();record=value;pdf=null;selectedId=null;styling=false;const run=epoch;
    root.hidden=false;{const same=key(record.name)===key(record.citation);$('viewer-title').textContent=same?record.citation:record.name;$('viewer-citation').textContent=same?'':record.citation;}$('page-scroll').scrollTop=0;
    const doc=await openPdf(record.document.data);if(run!==epoch){doc.destroy();return;}pdf=doc;
    const sizes=[];for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);if(run!==epoch)return;const v=page.getViewport({scale:1});sizes.push({width:v.width,height:v.height});}
    $('page-number').max=String(pdf.numPages);$('page-number').value='1';$('page-count').textContent=`of ${pdf.numPages}`;
    build(sizes);paint();renderSidebar();updateHistory();
    resizeObserver=new ResizeObserver(()=>{if(!pages.length||Math.abs($('page-scroll').clientWidth-lastWidth)<2)return;const n=currentPage();layout();for(const p of pages)if(p.rendered){release(p);}observer.disconnect();for(const p of pages)observer.observe(p.el);scrollToPage(n);});
    resizeObserver.observe($('page-scroll'));
    if(markId)await jump(markId);
  }, close:()=> $('close-viewer').click() };
}
