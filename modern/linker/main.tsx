import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, FileText, Link2, Loader2, X } from "lucide-react";
import "./linker.css";
import { authoritiesOperation } from "@/app/authorities/runtimeClient";
import { FileInputButton } from "@/app/authorities/FileInputButton";
import { OptionCards } from "@/app/authorities/OptionCards";
import { WorkspaceHeader } from "@/app/components/shared/WorkspaceHeader";
import { Button, buttonClassName } from "@/app/components/ui/button";

// Authority Linker: Authorities' page, frame and controls around one operation, a Word copy with its citations linked.
const FRAME = "mx-auto w-full max-w-[68rem] px-4 sm:px-6 md:mx-auto";
const CARD = "max-w-xl rounded-xl border border-gray-300 bg-white p-4 shadow-sm sm:p-5";
const LINKS = [
  { value: "pinpoint", label: "Pinpoint only", detail: "Each paragraph, section or page number gets its own link." },
  { value: "fragment", label: "Pinpoint + quoted text", detail: "The lead pinpoint also opens at the quoted words." },
] as const;
type Report = { citations: number; added: number; unsupported: number; preserved: number };
type Linked = { url: string; filename: string; report: Report };

function AuthorityLinker() {
  const [file, setFile] = useState<File | null>(null);
  const [links, setLinks] = useState<"pinpoint" | "fragment">("pinpoint");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [linked, setLinked] = useState<Linked | null>(null);
  const request = useRef<AbortController | null>(null);
  const busy = !!progress;
  const clear = () => { if (linked) URL.revokeObjectURL(linked.url); setLinked(null); setError(""); };
  const choose = (next?: File) => {
    clear();
    if (next && (!/\.docx$/iu.test(next.name) || next.size > 100 * 1024 * 1024)) { setError("Choose a Word .docx file, up to 100 MB."); return; }
    setFile(next ?? null);
  };
  const link = async () => {
    if (!file) return;
    clear(); request.current = new AbortController(); setProgress("Reading the Word document…");
    try {
      const result = await authoritiesOperation("word-hyperlinks" as never, { files: [file], textFragments: links === "fragment" },
        { signal: request.current.signal, progress: setProgress });
      const output = result.files?.[0];
      if (!output) throw new Error("The linked copy could not be created.");
      setLinked({ url: URL.createObjectURL(new Blob([output.bytes as Uint8Array<ArrayBuffer>], { type: output.mimeType })),
        filename: output.filename || "Document [linked].docx", report: result.data as Report });
    } catch (failure) {
      if (!request.current.signal.aborted) setError(failure instanceof Error ? failure.message : "The document could not be linked.");
    } finally { request.current = null; setProgress(""); }
  };
  return <div className="authorities-workspace relative h-dvh overflow-y-auto bg-app-background [scrollbar-gutter:stable]">
    <WorkspaceHeader className={FRAME} title="Authority Linker" />
    <main className={`${FRAME} space-y-4 pb-8 pt-4`}>
      <section className={CARD} aria-labelledby="linker-start">
        <div className="flex items-center gap-3"><Link2 className="h-6 w-6 shrink-0 text-accent-700" aria-hidden="true" />
          <div className="min-w-0"><h2 id="linker-start" className="font-semibold text-gray-950">Link citations</h2>
            <p className="text-sm text-gray-600">Add a Word document. Its citations and each written pinpoint get links in a copy; its text and formatting stay as they are.</p></div></div>
        {file ? <div className="mt-5 flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2">
          <FileText className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-950">{file.name}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove file" disabled={busy} onClick={() => choose()}><X /></Button>
        </div> : <div className="mt-5"><FileInputButton multiple={false} disabled={busy} label="Add file" ariaLabel="Word document"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onFiles={(files) => choose(files[0])} /></div>}
        <OptionCards className="mt-5" legend="Where the links open" value={links} options={LINKS} disabled={busy}
          onChange={(value) => { clear(); setLinks(value); }} />
        {links === "fragment" && <p className="mt-2 text-xs text-gray-600">Browsers don't always highlight quoted words; the link still opens at its pinpoint.</p>}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!file || busy} onClick={link}>{busy ? <Loader2 className="motion-safe:animate-spin" /> : <Link2 />}Add hyperlinks</Button>
          {busy && <Button type="button" variant="outline" className="border-gray-400" onClick={() => request.current?.abort()}>Cancel</Button>}
          <p role="status" aria-live="polite" className="text-sm text-gray-600">{progress}</p>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      </section>
      {linked && <section className={CARD} aria-labelledby="linker-result">
        <h2 id="linker-result" className="font-semibold text-gray-950">Linked copy</h2>
        <p className="mt-1 text-sm text-gray-600">{linked.report.added} hyperlinks added. {linked.report.unsupported} citations had no supported source link.
          {linked.report.preserved ? ` ${linked.report.preserved} placements were left unchanged to keep existing links or fields.` : ""}</p>
        <a className={buttonClassName({ className: "mt-4" })} href={linked.url} download={linked.filename}>
          <Download aria-hidden="true" />Download linked copy</a>
      </section>}
      <p className="max-w-xl text-xs text-gray-500">A range such as 41–43 keeps its wording: 41 and 43 link separately. Existing hyperlinks stay in place.
        Citations without a supported source link are left as they are. Nothing leaves this browser.</p>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<AuthorityLinker />);
