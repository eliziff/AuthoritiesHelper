// MIT. Citation recognition and structural boundaries belong to the shared Rust engine.
import { citationCall, extractCitations } from './engine.mjs';
import { printedPageIndices, resolvePrintedPages } from '../vendor/beaver/shared/pdf-page-binding.mjs';
export const key = (text, engine) => citationCall(engine, 'keyForText', { text: String(text || '') }).key;
export const targetLabel = t => `${t.kind === 'page' ? 'Page' : 'Para'} ${t.value}${t.item ? ` · item ${t.item}` : ''}`;
export function expandLocator({ first, last }) {
  if (last && /^\d+$/.test(first) && /^\d+$/.test(last)) {
    const a = +first, b = +last;
    if (a > b || b - a > 500) throw new Error('Pinpoint range is reversed or too large.');
    return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  }
  return !last && /^\d+[a-z]?$/i.test(first) ? [first] : [];
}
export function parseInstructions(text, engine) {
  if (text.length > 150_000) throw new Error('Paste no more than 150,000 characters at once.');
  const records = new Map();
  const occurrences = extractCitations(engine, text).filter(o => o.form === 'full' && o.authority === 'case');
  for (let i = 0; i < occurrences.length; i++) {
    const occurrence = occurrences[i];
    const hit = occurrence.span;
    const id = occurrence.key || `unresolved:${hit.start}:${hit.end}`;
    const name = occurrence.style?.text || occurrence.shortName || hit.text;
    const tail = text.slice(hit.end, Math.min(occurrences[i+1]?.fullSpan.start ?? text.length, text.indexOf('\n', hit.end) === -1 ? text.length : text.indexOf('\n', hit.end)));
    const pinpoints = occurrence.pinpoints || [];
    const nested = /\bitem\s+(\d+[a-z]?)\b/i.exec(tail)?.[1];
    const targets = pinpoints.filter(p => ['paragraph', 'page'].includes(p.kind)).flatMap(p => expandLocator(p).map(value => ({ kind: p.kind, value })));
    if (nested && targets.length === 1) targets[0].item = nested;
    const previous = records.get(id);
    const record = previous || { id, citation: hit.text.trim(), name, aliases: [hit.text.trim()], targets: [], enabled: Boolean(occurrence.key),
      status: occurrence.key ? 'Ready to find PDF' : 'Citation identity needs review', notes: [], court: occurrence.court?.text || '', family: occurrence.format, sourceUrl: null };
    for (const target of targets) if (!record.targets.some(t => JSON.stringify(t) === JSON.stringify(target))) record.targets.push(target);
    records.set(id, record);
  }
  return [...records.values()];
}
export function findTargets(document, targets, engine) {
  const { nodes, text, lines } = document;
  return targets.map(target => {
    let selected = [];
    if (target.kind === 'page') {
      const labels=document.pageLabels||[];
      const indices=resolvePrintedPages(String(target.value),printedPageIndices(labels),labels.length);
      return indices.length?{target,status:'unlocated',pdfPage:indices[0]+1,
        message:`Printed page mapped to PDF ${indices.map(index=>index+1).join(', ')}; open it to mark the passage.`}
        :{target,status:'unlocated',message:'Printed page could not be mapped; use the PDF page controls to add a mark.'};
    }
    const matching = nodes.filter(n => n.kind === 'paragraph' && [n.label, ...(n.aliases || [])].some(l => l === `par${target.value}`));
    if (matching.length !== 1) return { target, status: 'unlocated', message: matching.length ? 'Repeated paragraph address needs review.' : 'Paragraph address was not confidently located.' };
    let { start, end } = matching[0].range;
    if (target.item) {
      const {range}=engine({op:'numbered_item',parent:{start,end},item:target.item,
        lines:lines.filter(l=>l.start>=start&&l.start<end).map(l=>[l.start,l.text])});
      if (!range) return { target, status: 'unlocated', message: `Paragraph found; item ${target.item} needs review.` };
      ({start,end}=range);
    }
    selected = lines.filter(l => l.end > start && l.start < end && l.text.trim() && !l.excluded);
    if (!selected.length) return { target, status: 'unlocated', message: 'The paragraph has no reliable page geometry.' };
    const fragments = [];
    for (const line of selected) {
      let fragment = fragments.find(f => f.pageNumber === line.pageNumber);
      if (!fragment) fragments.push(fragment = { pageNumber: line.pageNumber, rects: [] });
      fragment.rects.push(line.rect);
    }
    return { target, status: 'found', fragments, excerpt: text.slice(start, end).trim().slice(0, 2000) };
  });
}
export function initialMarks(findings) {
  return findings.filter(f => f.status === 'found').map((f, i) => ({ id: `auto-${i}-${f.target.value}`, kind: 'highlight', origin: 'automatic', label: targetLabel(f.target),
    excerpt: f.excerpt, rgb: [1, .93, .45], opacity: .3, fragments: f.fragments }));
}
// CanLII names its PDFs by neutral citation (2019abqb666.pdf); browsers append " (1)" to repeats.
export const CANLII_PDF_NAME = /^(\d{4})([a-z]{2,10})(\d{1,5})(?: ?\(\d+\))?\.pdf$/i;
// Newest top-level CanLII-named PDF per citation, e.g. {citation:'2019 ABQB 666', file}; same rules as pickDownloads.
export function canliiFiles(files) {
  const best = new Map();
  for (const file of files) {
    const match = CANLII_PDF_NAME.exec(file.name);
    if (!match || (file.webkitRelativePath || '').split('/').length > 2) continue;
    const citation = `${match[1]} ${match[2].toUpperCase()} ${match[3]}`;
    if (!(best.get(citation)?.lastModified >= file.lastModified)) best.set(citation, file);
  }
  return [...best].map(([citation, file]) => ({ citation, file }));
}
// Picks, per authority still missing its PDF, the newest top-level file named for one of its citations.
export function pickDownloads(files, records, engine) {
  const wanted = new Map();
  for (const r of records) if (!r.document) for (const c of r.aliases) { const identity = key(c, engine); if (identity) wanted.set(identity, r); }
  const best = new Map();
  for (const file of files) {
    const match = CANLII_PDF_NAME.exec(file.name);
    if (!match || (file.webkitRelativePath || '').split('/').length > 2) continue;
    const record = wanted.get(key(match.slice(1, 4).join(' '), engine));
    if (record && !(best.get(record)?.lastModified >= file.lastModified)) best.set(record, file);
  }
  return [...best].map(([record, file]) => ({ record, file }));
}
