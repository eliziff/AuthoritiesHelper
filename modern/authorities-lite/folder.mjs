import {key, CANLII_PDF_NAME} from './domain.mjs';
import {headerIdentities, verifyIdentity} from './pdf.mjs';

const words=text=>String(text||'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
export const referenceText=text=>' '+words(text).join(' ')+' ';

// Filename is a routing hint. Native text, when available, must agree independently.
export function matchFolderPdf(filename,pages,records,engine){
  const named=CANLII_PDF_NAME.exec(filename),reporter=/^(\d{4})(scr|rcs)(\d*)_(\d+)(?: ?\(\d+\))?\.pdf$/i.exec(filename);
  const nameKey=key(named?named.slice(1,4).join(' '):reporter?`[${reporter[1]}] ${reporter[3]} ${reporter[2].toUpperCase()} ${reporter[4]}`:filename.replace(/\.pdf$/i,''),engine);
  const namedRecords=nameKey?records.filter(r=>r.aliases.some(a=>key(a,engine)===nameKey)):[];
  const text=pages.map(p=>p.lines.map(l=>l.text).join('\n')).join('\n');
  const tokens=words(text);
  if(tokens.length<12)return namedRecords.length===1?{record:namedRecords[0],method:'filename'}:null;
  const header=headerIdentities(pages,engine),neutral=header.filter(c=>c.family==='neutral');
  const identities=new Set((neutral.length?neutral.slice(0,1):header).map(c=>c.key).filter(Boolean));
  const candidates=records.filter(r=>r.aliases.some(a=>identities.has(key(a,engine))));
  const verified=candidates.filter(r=>{try{verifyIdentity(pages,r,engine);return true;}catch{return false;}});
  if(verified.length===1)return {record:verified[0],method:'citation'};
  if(verified.length>1||neutral.length)return null;
  // Exact opening-text agreement; never pick a best fuzzy score. Require a majority
  // and at least two phrases unique among the pending authorities' reference texts.
  const phrases=[...new Set(Array.from({length:Math.floor(Math.min(tokens.length,1200)/12)},(_,i)=>' '+tokens.slice(i*12,i*12+12).join(' ')+' '))];
  const references=records.map(r=>r.identityText||referenceText(r.referenceText));
  const matches=references.map(ref=>phrases.map(p=>ref.includes(p)));
  const supported=records.filter((_,i)=>{
    const count=matches[i].filter(Boolean).length;
    const unique=matches[i].filter((yes,j)=>yes&&!matches.some((other,k)=>k!==i&&other[j])).length;
    return count>phrases.length/2&&unique>=2;
  });
  return supported.length===1?{record:supported[0],method:'text'}:null;
}
