// MIT. Citation recognition and structural boundaries belong to the shared Rust engine.
export const key = text => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const targetLabel = t => `${t.kind === 'page' ? 'Page' : 'Para'} ${t.value}${t.item ? ` · item ${t.item}` : ''}`;
export function expandLocator(text) {
  const range = /^\s*(\d+)\s*[-–—]\s*(\d+)\s*$/.exec(text);
  if (range) {
    const a = +range[1], b = +range[2];
    if (a > b || b - a > 500) throw new Error('Pinpoint range is reversed or too large.');
    return Array.from({ length: b - a + 1 }, (_, i) => String(a + i));
  }
  return /^\d+[a-z]?$/i.test(text.trim()) ? [text.trim()] : [];
}
export function parseInstructions(text, engine) {
  if (text.length > 150_000) throw new Error('Paste no more than 150,000 characters at once.');
  const parsed = engine({ op: 'citations', text }), records = new Map();
  const occurrences = parsed.occurrences.filter(o => o.kind === 'case');
  for (let i = 0; i < occurrences.length; i++) {
    const occurrence = occurrences[i];
    const hit = parsed.matches.find(m => m.start === occurrence.coreCitation.start && m.end === occurrence.coreCitation.end);
    if (!hit) continue;
    const id = hit.key || key(hit.text);
    const before = text.slice(Math.max(text.lastIndexOf('\n', hit.start - 1) + 1, i ? occurrences[i-1].end : 0), hit.start).trim();
    const related = /\b(adopting|citing|following|quoting)\s+([^\n]+?),?\s*$/i.exec(before);
    const style = occurrence.shortForm || related?.[2]?.replace(/,\s*$/, '') || before.replace(/^[\s(]+|[,\s]+$/g, '');
    const name = style && style.length < 180 && !/please|download|highlight/i.test(style) ? style : hit.text;
    const tail = text.slice(hit.end, Math.min(occurrences[i+1]?.start ?? text.length, text.indexOf('\n', hit.end) === -1 ? text.length : text.indexOf('\n', hit.end)));
    let pinpoints = occurrence.pinpoints;
    // A narrowly scoped typo adapter, after Rust has identified the citation itself.
    if (!pinpoints.length) {
      const typo = /^\s*,?\s*pars?\.?\s*(\d+(?:\s*[-–]\s*\d+)?)/i.exec(tail);
      if (typo) pinpoints = [{ kind: 'paragraph', text: typo[1] }];
    }
    const nested = /\bitem\s+(\d+[a-z]?)\b/i.exec(tail)?.[1];
    const targets = pinpoints.filter(p => ['paragraph', 'page'].includes(p.kind)).flatMap(p => expandLocator(p.text).map(value => ({ kind: p.kind, value })));
    if (nested && targets.length === 1) targets[0].item = nested;
    const previous = records.get(id);
    const record = previous || { id, citation: hit.text.trim(), name, aliases: [hit.text.trim()], targets: [], enabled: true,
      status: 'Ready to find PDF', notes: [], court: hit.court || '', family: hit.family, sourceUrl: null };
    for (const target of targets) if (!record.targets.some(t => JSON.stringify(t) === JSON.stringify(target))) record.targets.push(target);
    records.set(id, record);
  }
  return [...records.values()];
}
export function findTargets(document, targets) {
  const { nodes, text, lines } = document;
  return targets.map(target => {
    let selected = [];
    if (target.kind === 'page') {
      // Physical page is deliberately explicit, never silently treated as a reporter page.
      return { target, status: 'unlocated', message: 'Reporter-page pinpoints need review; use the PDF page controls to add a mark.' };
    }
    const matching = nodes.filter(n => n.kind === 'paragraph' && [n.label, ...(n.aliases || [])].some(l => l === `par${target.value}`));
    if (matching.length !== 1) return { target, status: 'unlocated', message: matching.length ? 'Repeated paragraph address needs review.' : 'Paragraph address was not confidently located.' };
    let { start, end } = matching[0].range;
    if (target.item) {
      // The parent extent comes from Rust. Only a visibly bounded list item inside it may narrow the target.
      const inside = lines.filter(l => l.start >= start && l.start < end);
      const markers = inside.flatMap(l => {
        const m = /^\s*(?:\((\d+[a-z]?)\)|(\d+[a-z]?)[.)])\s+/i.exec(l.text);
        return m ? [{ line: l, value: m[1] || m[2] }] : [];
      });
      const index = markers.findIndex(m => m.value === target.item);
      if (index < 0 || markers.filter(m => m.value === target.item).length !== 1) return { target, status: 'unlocated', message: `Paragraph found; item ${target.item} needs review.` };
      start = markers[index].line.start; end = markers[index + 1]?.line.start ?? end;
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
// Newest recent top-level CanLII-named PDF per citation, e.g. {citation:'2019 ABQB 666', file}; same rules as pickDownloads.
export function recentCanliiFiles(files, now = Date.now(), maxAge = 24 * 60 * 60 * 1000) {
  const best = new Map();
  for (const file of files) {
    const match = CANLII_PDF_NAME.exec(file.name);
    if (!match || (file.webkitRelativePath || '').split('/').length > 2 || now - file.lastModified > maxAge) continue;
    const citation = `${match[1]} ${match[2].toUpperCase()} ${match[3]}`;
    if (!(best.get(citation)?.lastModified >= file.lastModified)) best.set(citation, file);
  }
  return [...best].map(([citation, file]) => ({ citation, file }));
}
// Picks, per authority still missing its PDF, the newest recent top-level file named for one of its citations.
export function pickDownloads(files, records, now = Date.now(), maxAge = 24 * 60 * 60 * 1000) {
  const wanted = new Map();
  for (const r of records) if (!r.document) for (const c of r.aliases) wanted.set(key(c), r);
  const best = new Map();
  for (const file of files) {
    const match = CANLII_PDF_NAME.exec(file.name);
    if (!match || (file.webkitRelativePath || '').split('/').length > 2 || now - file.lastModified > maxAge) continue;
    const record = wanted.get(key(match.slice(1, 4).join('')));
    if (record && !(best.get(record)?.lastModified >= file.lastModified)) best.set(record, file);
  }
  return [...best].map(([record, file]) => ({ record, file }));
}
