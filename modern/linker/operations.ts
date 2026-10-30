import { Buffer } from "buffer";
import { importStandaloneAuthoritiesFile } from "../../../backend/src/lib/authoritiesImport";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { writeDocxSpans, type DocxSpanWrite } from "../../../backend/src/lib/docxOperations";
import { sourceUrl } from "../../../backend/src/lib/legalSourceLinks";
import { authoritySourceUrl } from "../../../shared/authorities-sources.mjs";
import { partLinks, writtenAddress } from "../../../shared/runtime/wordLinks.mjs";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Authority Linker's runtime hosts one operation: a Word copy with its citations linked. Each citation's words open its
// page, and its pinpoints the places the engine's pinpointLinks gives: by default each number its own ("30–32": 30 and
// 32), or with `wholePinpoint` the pinpoint's words its first.
export function createAuthoritiesOperations() {
  return { "word-hyperlinks": async (input: { files?: Array<{ filename: string; bytes: Uint8Array; modified: number }>;
    body?: boolean; wholePinpoint?: boolean }, context?: { signal?: AbortSignal; progress?: (text: string) => void }) => {
    const file = input.files?.[0];
    if (!file || input.files?.length !== 1 || !/\.docx$/iu.test(file.filename) || file.bytes.length > 100 * 1024 * 1024)
      throw new Error("Choose one Word .docx file, up to 100 MB.");
    context?.progress?.("Reading the Word document…");
    const bytes = Buffer.from(file.bytes);
    const draft = await importStandaloneAuthoritiesFile({ filename: file.filename, fileType: "docx", bytes,
      modified: file.modified, sourceMode: "manual-originals" });
    const native = structureNative();
    const units = new Map(draft.units.map((unit) => [unit.id, unit]));
    const writes: DocxSpanWrite[] = [];
    for (const occurrence of Object.values(draft.occurrences)) {
      context?.signal?.throwIfAborted();
      const unit = units.get(occurrence.unitId)!;
      if (!input.body && unit.kind !== "footnote") continue;
      const authority = occurrence.authorityId ? draft.authorities[occurrence.authorityId] : null;
      const page = sourceUrl(occurrence.link || (authority && ((authority.kind === "legislation"
        ? native.canliiLawUrl(authority.citation) : native.canliiCaseUrl([authority.citation], "en", null))
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
}
