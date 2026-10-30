import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, FileText, Link2, Loader2, X } from "lucide-react";
import "./linker.css";
import { authoritiesOperation } from "@/app/authorities/runtimeClient";
import { FileInputButton } from "@/app/authorities/FileInputButton";
import { OptionCards } from "@/app/authorities/OptionCards";
import { WorkspaceHeader } from "@/app/components/shared/WorkspaceHeader";
import { Button, buttonClassName } from "@/app/components/ui/button";

// Authority Linker: Authorities' page around one operation, a Word copy with its citations linked.
const FRAME = "mx-auto w-full max-w-[68rem] px-4 sm:px-6 md:mx-auto";
const CARD = "max-w-xl rounded-xl border border-gray-300 bg-white p-4 shadow-sm sm:p-5";
type Linked = { url: string; filename: string; added: number };
const WHERE = [{ value: "footnotes", label: "Footnotes" }, { value: "body", label: "Footnotes and body" }] as const;
const PINPOINTS = [{ value: "numbers", label: "Numbers" }, { value: "whole", label: "Whole pinpoint" }] as const;

function AuthorityLinker() {
  const [file, setFile] = useState<File | null>(null);
  const [where, setWhere] = useState<"footnotes" | "body">("footnotes");
  const [pinpoints, setPinpoints] = useState<"numbers" | "whole">("numbers");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [linked, setLinked] = useState<Linked | null>(null);
  const request = useRef<AbortController | null>(null);
  const busy = !!progress;
  const choose = (next?: File) => {
    if (linked) URL.revokeObjectURL(linked.url);
    setLinked(null); setError(""); setFile(next ?? null);
  };
  const link = async () => {
    if (!file) return;
    request.current = new AbortController(); setError(""); setProgress("Reading the Word document…");
    try {
      const result = await authoritiesOperation("word-hyperlinks" as never, { files: [file], body: where === "body", wholePinpoint: pinpoints === "whole" },
        { signal: request.current.signal, progress: setProgress });
      const output = result.files![0];
      setLinked({ url: URL.createObjectURL(new Blob([output.bytes as Uint8Array<ArrayBuffer>], { type: output.mimeType })),
        filename: output.filename!, added: (result.data as { added: number }).added });
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
            <p className="text-sm text-gray-600">Add a Word document.</p></div></div>
        {file ? <div className="mt-5 flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2">
          <FileText className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-950">{file.name}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove file" disabled={busy} onClick={() => choose()}><X /></Button>
        </div> : <div className="mt-5"><FileInputButton multiple={false} disabled={busy} label="Add file" ariaLabel="Word document"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onFiles={(files) => choose(files[0])} /></div>}
        <OptionCards className="mt-5" legend="Citations in" value={where} options={WHERE} disabled={busy} columns
          onChange={(value) => { choose(file ?? undefined); setWhere(value); }} />
        <OptionCards className="mt-4" legend="Pinpoint links on" value={pinpoints} options={PINPOINTS} disabled={busy} columns
          onChange={(value) => { choose(file ?? undefined); setPinpoints(value); }} />
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!file || busy} onClick={link}>{busy ? <Loader2 className="motion-safe:animate-spin" /> : <Link2 />}Add hyperlinks</Button>
          {busy && <Button type="button" variant="outline" className="border-gray-400" onClick={() => request.current?.abort()}>Cancel</Button>}
          <p role="status" aria-live="polite" className="text-sm text-gray-600">{progress}</p>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      </section>
      {linked && <section className={CARD} aria-labelledby="linker-result">
        <h2 id="linker-result" className="font-semibold text-gray-950">Linked copy</h2>
        <p className="mt-1 text-sm text-gray-600">{linked.added} links added</p>
        <a className={buttonClassName({ className: "mt-4" })} href={linked.url} download={linked.filename}>
          <Download aria-hidden="true" />Download linked copy</a>
      </section>}
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<AuthorityLinker />);
