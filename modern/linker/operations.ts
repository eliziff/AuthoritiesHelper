import { Buffer } from "buffer";
import JSZip from "jszip";
import { importStandaloneAuthoritiesFile } from "../../../backend/src/lib/authoritiesImport";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { writeDocxSpans, type DocxSpanWrite } from "../../../backend/src/lib/docxOperations";
import { sourceUrl } from "../../../backend/src/lib/legalSourceLinks";
import { authoritySourceUrl } from "../../../shared/authorities-sources.mjs";
import { partLinks, writtenAddress } from "../../../shared/runtime/wordLinks.mjs";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// A short Word document of the citations the operation reads (a case by its neutral citation and report, a statute,
// pinpoints, ibid and supra), in its body and its footnotes: linked while the page waits for the first document, it
// builds what that document's reading would build first, and nothing a document would not.
async function warmDocument(): Promise<Uint8Array> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  const note = (id: number, text: string) => `<w:footnote w:id="${id}"><w:p>${run(text)}</w:p></w:footnote>`;
  const reference = (id: number) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>`
    + `<w:p>${run("The Court applied R v Jordan, 2016 SCC 27 at paras 46-48, and the Criminal Code, RSC 1985, c C-46, s 11(b).")}${reference(1)}</w:p>`
    + `<w:p>${run("It followed Canada (Attorney General) v Bedford, [2013] 3 SCR 1101 at para 96.")}${reference(2)}</w:p></w:body></w:document>`);
  zip.file("word/footnotes.xml", `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W}>`
    + note(1, "R v Jordan, 2016 SCC 27 at para 105; see also R v Oakes, [1986] 1 SCR 103 at 138-39.")
    + note(2, "Ibid at para 98; Jordan, supra note 1 at para 49; Charter, s 7.") + "</w:footnotes>");
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

// Authority Linker's runtime hosts one operation: a Word copy with its citations linked. Each citation's words open its
// page, and its pinpoints the places the engine's pinpointLinks gives: by default each number its own ("30–32": 30 and
// 32), or with `wholePinpoint` the pinpoint's words its first. A case opens the CanLII page its citation names, through the
// alias table for a report's citation ("[1986] 1 SCR 103"), or with `neutralOnly` only a neutral or CanLII citation's.
type WordFile = { filename: string; bytes: Uint8Array; modified: number };
const chosen = (files?: WordFile[]) => {
  const file = files?.[0];
  if (!file || files?.length !== 1 || !/\.docx$/iu.test(file.filename) || file.bytes.length > 100 * 1024 * 1024)
    throw new Error("Choose one Word .docx file, up to 100 MB.");
  return file;
};

export function createAuthoritiesOperations() {
  // The document last chosen, read once: the page has it read when it is chosen ("word-read"), before its links are
  // asked for, and linking those same bytes takes that reading (the options choose only which links are written).
  let reading: { file: WordFile; draft: ReturnType<typeof importStandaloneAuthoritiesFile> } | null = null;
  const read = (file: WordFile) => {
    if (reading?.file.filename === file.filename && reading.file.modified === file.modified
      && Buffer.from(reading.file.bytes).equals(Buffer.from(file.bytes))) return reading.draft;
    const draft = importStandaloneAuthoritiesFile({ filename: file.filename, fileType: "docx", bytes: Buffer.from(file.bytes),
      modified: file.modified, sourceMode: "manual-originals" });
    // A document that cannot be read says so when its links are asked for.
    draft.catch(() => undefined);
    reading = { file, draft };
    return draft;
  };
  const operations = { "word-hyperlinks": async (input: { files?: WordFile[];
    body?: boolean; wholePinpoint?: boolean; neutralOnly?: boolean },
  context?: { signal?: AbortSignal; progress?: (text: string) => void }) => {
    const file = chosen(input.files);
    context?.progress?.("Reading the Word document…");
    const bytes = Buffer.from(file.bytes);
    const draft = await read(file);
    const native = structureNative();
    const units = new Map(draft.units.map((unit) => [unit.id, unit]));
    const writes: DocxSpanWrite[] = [];
    for (const occurrence of Object.values(draft.occurrences)) {
      context?.signal?.throwIfAborted();
      const unit = units.get(occurrence.unitId)!;
      if (!input.body && unit.kind !== "footnote") continue;
      const authority = occurrence.authorityId ? draft.authorities[occurrence.authorityId] : null;
      const page = sourceUrl(occurrence.link || (authority && ((authority.kind === "legislation"
        ? native.canliiLawUrl(authority.citation) : input.neutralOnly ? native.canliiCaseUrl([authority.citation], "en", null)
          : native.citationEngineCall("canliiAliasTarget", JSON.stringify({ target: authority.citation })) as string | null)
        ?? authoritySourceUrl(authority))) || "");
      if (!page) continue;
      // The pinpoints as the import read them, at the words the unit writes for each.
      const pinpoints = occurrence.pinpoints.flatMap(({ kind, start, end, first, last }) => start === undefined || end === undefined
        ? [] : [{ kind, span: { start, end, text: unit.text.slice(start, end) }, first: first ?? "", last }]);
      const numbers = (pinpoints.length ? native.citationEngineCall("pinpointLinks", JSON.stringify({ pinpoints, url: page })) as
        Array<{ pinpoint: number; start: number; end: number; text: string; url: string }> : [])
        .map(({ pinpoint, start, end, text, url }) => ({ span: { start: pinpoints[pinpoint].span.start + start,
          end: pinpoints[pinpoint].span.start + end, text }, url }));
      const link = input.wholePinpoint && numbers[0]?.url || page;
      const parts = { core: occurrence.coreSpan.text ? occurrence.coreSpan : null, pinpoint: occurrence.pinpointSpan,
        written: writtenAddress(occurrence.text, occurrence.start, link) };
      for (const { span, url } of input.wholePinpoint ? partLinks(parts, link)
        : [...partLinks({ ...parts, pinpoint: null }, page), ...numbers]) {
        if (!writes.some((write) => write.unitId === occurrence.unitId && write.start < span.end && span.start < write.end))
          writes.push({ kind: "link", unitId: occurrence.unitId, start: span.start, end: span.end, expected: span.text, url });
      }
    }
    context?.progress?.("Adding links…");
    const result = await writeDocxSpans(bytes, draft.units, writes, "Authority Linker");
    return { data: { added: result.written.filter(Boolean).length }, files: [{ role: "docx", mimeType: DOCX,
      filename: file.filename.replace(/\.docx$/iu, " [linked].docx"), bytes: new Uint8Array(result.bytes) }] };
  } };
  // The runtime runs this while the page waits for its first document (runtime-worker.mjs).
  return { ...operations, "word-read": async (input: { files?: WordFile[] }) => {
    await read(chosen(input.files));
    return { data: {} };
  }, "warm-up": async (_input: unknown, context?: { signal?: AbortSignal }) => {
    await operations["word-hyperlinks"]({ files: [{ filename: "warm-up.docx", bytes: await warmDocument(), modified: 0 }], body: true }, context);
    return { data: {} };
  } };
}
