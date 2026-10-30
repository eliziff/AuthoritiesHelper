import { Buffer } from "buffer";
import { importStandaloneAuthoritiesFile } from "../../../backend/src/lib/authoritiesImport";
import { structureNative } from "../../../backend/src/lib/structureNative";
import { writeDocxSpans, type DocxSpanWrite } from "../../../backend/src/lib/docxOperations";
import { sourceUrl } from "../../../backend/src/lib/legalSourceLinks";
import { splitQuoteChecks } from "../../../backend/src/lib/quoteCheck";
import { splitQuoteCitationUnits } from "../../../backend/src/lib/quoteCitationSplit";
import { authoritySourceUrl } from "../../../shared/authorities-sources.mjs";
import { partLinks, writtenAddress } from "../../../shared/runtime/wordLinks.mjs";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Authority Linker's runtime hosts one operation: a Word copy with its citations and each written pinpoint linked.
// No sources are fetched, no wording is checked, nothing is stored.
export function createAuthoritiesOperations() {
  return { "word-hyperlinks": async (input: { files?: Array<{ filename: string; bytes: Uint8Array; modified: number }>;
    textFragments?: boolean }, context?: { signal?: AbortSignal; progress?: (text: string) => void }) => {
    const file = input.files?.[0];
    if (!file || input.files?.length !== 1 || !/\.docx$/iu.test(file.filename) || file.bytes.length > 100 * 1024 * 1024)
      throw new Error("Choose one Word .docx file, up to 100 MB.");
    context?.progress?.("Reading the Word document…");
    const bytes = Buffer.from(file.bytes);
    const draft = await importStandaloneAuthoritiesFile({ filename: file.filename, fileType: "docx", bytes,
      modified: file.modified, sourceMode: "manual-originals" });
    context?.signal?.throwIfAborted();
    const native = structureNative();
    // A quotation's words, for the fragment on its citation's lead pinpoint.
    const quotes = input.textFragments ? splitQuoteChecks(draft, [],
      await splitQuoteCitationUnits(draft.units.map((unit) => unit.text), context?.signal)) : [];
    const writes: DocxSpanWrite[] = [];
    let unsupported = 0, citations = 0;
    for (const occurrence of Object.values(draft.occurrences)) {
      context?.signal?.throwIfAborted();
      const authority = occurrence.authorityId ? draft.authorities[occurrence.authorityId] : null;
      const built = authority ? native.canliiLawUrl(authority.citation)
        ?? native.canliiCaseUrl([authority.citation], "en", null) ?? authoritySourceUrl(authority) : null;
      const link = sourceUrl(occurrence.link || built || "");
      if (!link) { unsupported++; continue; }
      const quotation = quotes.find((quote) => quote.candidates.some((candidate) => candidate.id === occurrence.id))?.quote;
      const placement = partLinks({ core: occurrence.coreSpan.text ? occurrence.coreSpan : null,
        pinpoint: occurrence.pinpointSpan, written: writtenAddress(occurrence.text, occurrence.start, link) }, link,
      { individualPinpoints: true, pinpoints: occurrence.pinpoints,
        textFragments: input.textFragments === true, quotedText: quotation });
      for (const { span, url } of placement) {
        if (!writes.some((write) => write.unitId === occurrence.unitId && write.start < span.end && span.start < write.end))
          writes.push({ kind: "link", unitId: occurrence.unitId, start: span.start, end: span.end, expected: span.text, url });
      }
      citations++;
    }
    context?.progress?.("Adding hyperlinks to a copy…");
    const result = await writeDocxSpans(bytes, draft.units, writes, "Authority Linker");
    const added = result.written.filter(Boolean).length;
    return { data: { citations, added, unsupported, preserved: writes.length - added }, files: [{ role: "docx",
      filename: file.filename.replace(/\.docx$/iu, " [linked].docx"), mimeType: DOCX, bytes: new Uint8Array(result.bytes) }] };
  } };
}
