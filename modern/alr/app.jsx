// The ALR Quote Verifier page: the desktop app's Verify and Settings tabs (ALR-Quote-Verifier gui.py)
// over Beaver's verifier, which runs in the shared Authorities runtime Worker (html/page-bridge.mjs).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Check, Download, ExternalLink, FilePlus2, FileText, FolderSearch, Play, Square, X } from "lucide-react";
import { chooseWatchedFolder, folderPermission, requestFolderAccess, watchFolder } from "../../../shared/folder-watch.mjs";
import { EXPORT_DETAIL, FRAG_MODES, PARALLEL_FILES, PROPOSITION_MODES, RUN_MODES, SUPRA_LINKING, DEFAULT_SETTINGS,
  withDefaults } from "./settings.mjs";
import { keep, kept } from "./store.mjs";
import { ProviderPanel, providerReady, providerForRun } from "./providers/panel.jsx";
import { CorpusPanel, corpusForRun, corpusReady } from "./corpus/panel.jsx";

const PHASES = [
  ["read", "Read document & footnotes"],
  ["analyze", "Analyze & link citations"],
  ["journal", "Match journal articles"],
  ["supra", "Connect ibid & supra references"],
  ["quotes", "Verify quotations"],
  ["write", "Write Excel workbook"],
];
// How far through a document each phase starts: footnote analysis is the bulk of a run.
const PHASE_SPAN = { read: [0, 0.02], analyze: [0.02, 0.85], journal: [0.85, 0.88], supra: [0.88, 0.91],
  quotes: [0.91, 0.99], write: [0.99, 1] };
// What each phase is doing, until the verifier says more (gui.py DocProgressView.feed).
const PHASE_NOW = { read: "Reading the document…", analyze: "Splitting footnotes into citations…",
  journal: "Matching journal articles against the article database…", supra: "Connecting ibid and supra references…",
  quotes: "Checking each quotation against its source…", write: "Writing the Excel workbook…" };
const COUNTS = [
  ["perfect", "Perfect match"], ["partial", "Partial match"], ["noMatch", "No match"], ["unavailable", "Unavailable"],
];

// ---------------------------------------------------------------- state
// Application state lives outside React: long-running work mutates it and emit() re-renders.
const state = {
  loaded: false, view: "verify", settings: { ...DEFAULT_SETTINGS }, documents: [], selected: null, lower: "highlights",
  running: false, stopping: false, startedAt: 0, notice: "", sources: [], folderNote: "",
  folder: null, // { name, watching, ask } — the watched Downloads folder
};
let version = 0;
const listeners = new Set();
function emit() { version += 1; for (const listener of listeners) listener(); }
const useVersion = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  () => version);
const notice = (text) => { state.notice = text; emit(); };

let nextId = 1;
const newDocument = (file, bytes) => ({ id: `${Date.now()}-${nextId++}`, name: file.name, size: file.size, bytes,
  status: "ready", phase: null, done: 0, total: 0, fraction: 0, now: [], highlights: [], result: null, error: "" });

// What a reload keeps: each document with its bytes and finished result, the sources step, the folder.
let saving;
function save() {
  clearTimeout(saving);
  saving = setTimeout(() => {
    void keep("settings", state.settings);
    void keep("documents", state.documents.map(({ now: _now, ...document }) => ({ ...document,
      status: document.status === "running" || document.status === "queued" ? "interrupted" : document.status })));
    void keep("sources", state.sources);
  }, 250);
}
async function load() {
  const [settings, documents, sources, folder] = await Promise.all([kept("settings"), kept("documents"), kept("sources"),
    kept("folder")]);
  state.settings = withDefaults(settings);
  state.documents = (documents ?? []).map((document) => ({ ...document, now: [] }));
  state.selected = state.documents[0]?.id ?? null;
  state.sources = sources ?? [];
  state.loaded = true;
  if (folder) await resumeFolder(folder);
  emit();
}
function setSetting(key, value) {
  state.settings = { ...state.settings, [key]: value };
  save(); emit();
}

// ---------------------------------------------------------------- documents
const accepted = (name) => /\.docx$/iu.test(name) || (state.settings.pdf_input && /\.pdf$/iu.test(name));
async function addFiles(files) {
  if (state.running) return;
  const list = Array.from(files), usable = list.filter((file) => accepted(file.name));
  const skipped = list.length - usable.length;
  for (const file of usable) {
    if (state.documents.some((document) => document.name === file.name && document.size === file.size)) continue;
    state.documents.push(newDocument(file, new Uint8Array(await file.arrayBuffer())));
  }
  state.selected ??= state.documents[0]?.id ?? null;
  notice(skipped ? `${skipped} file${skipped === 1 ? " was" : "s were"} not added: the verifier reads .docx files${
    state.settings.pdf_input ? " and PDFs" : ". PDF input can be turned on in Settings, under Advanced"}.` : "");
  save();
}
function removeDocument(id) {
  if (state.running) return;
  state.documents = state.documents.filter((document) => document.id !== id);
  if (state.selected === id) state.selected = state.documents[0]?.id ?? null;
  state.sources = state.sources.map((source) => ({ ...source, documents: source.documents.filter((doc) => doc !== id) }))
    .filter((source) => source.documents.length);
  save(); emit();
}
function clearDocuments() {
  if (state.running) return;
  state.documents = []; state.selected = null; state.sources = []; state.notice = "";
  save(); emit();
}
const pickFiles = () => {
  const input = Object.assign(document.createElement("input"), { type: "file", multiple: true,
    accept: state.settings.pdf_input ? ".docx,.pdf" : ".docx" });
  input.onchange = () => void addFiles(input.files ?? []);
  input.click();
};

// ---------------------------------------------------------------- run
const operations = (operation, input, options) => globalThis.AUTHORITIES_OPERATIONS(operation, input, options);
let controller;

function nowLine(document, text) {
  if (!text || document.now.at(-1) === text) return;
  document.now = [...document.now, text].slice(-2);
}
function highlight(document, text, tone = "dim") {
  document.highlights = [...document.highlights, { text, tone }].slice(-400);
}
function progressEvent(document, event) {
  if (typeof event === "string") { nowLine(document, event); emit(); return; }
  const { phase, done, total, message } = event ?? {};
  if (phase && PHASE_SPAN[phase]) {
    if (phase !== document.phase) {
      // A finished count is news: how many footnotes were read, how many quotations checked.
      if (document.phase === "analyze" && document.total) highlight(document, `Analyzed ${document.total} footnote${document.total === 1 ? "" : "s"}.`, "ok");
      document.phase = phase; document.now = []; document.done = document.total = 0;
      if (!message) nowLine(document, PHASE_NOW[phase]);
    }
    if (Number.isFinite(total) && total > 0) { document.done = done ?? 0; document.total = total; }
    const [start, end] = PHASE_SPAN[phase];
    const share = Number.isFinite(total) && total > 0 ? Math.min(1, (done ?? 0) / total) : 0;
    document.fraction = Math.max(document.fraction, start + (end - start) * share);
    if (phase === "analyze" && total) noteFootnotes();
  }
  if (message) nowLine(document, message);
  emit();
}

function summaryHighlights(document, result) {
  const { footnotes, parts, quotes, perfect, partial, noMatch, unavailable } = result.summary;
  highlight(document, `Wrote ${parts} citation part${parts === 1 ? "" : "s"} from ${footnotes} footnote${footnotes === 1 ? "" : "s"} to the workbook.`, "ok");
  if (quotes) highlight(document, `Checked ${quotes} quotation${quotes === 1 ? "" : "s"}: ${perfect} perfect, ${partial} partial, ${noMatch} not found, ${unavailable} without source text.`,
    noMatch ? "warn" : "ok");
  else highlight(document, "Found no quotations to check.", "dim");
  const failures = result.sourceFailures ?? [];
  if (failures.length) highlight(document, `${failures.length} source lookup${failures.length === 1 ? "" : "s"} could not be answered, first: ${failures[0]}`, "warn");
  const missing = result.missingSources?.length ?? 0;
  if (missing) highlight(document, `${missing} source${missing === 1 ? "" : "s"} A2AJ could not supply can be added from CanLII under Sources to add.`, "warn");
}

/** The sources step across the run: one row per source still without text, naming its documents. */
function mergeSources(document, missing) {
  const rows = state.sources.map((source) => ({ ...source, documents: source.documents.filter((id) => id !== document.id) }));
  for (const source of missing ?? []) {
    const row = rows.find((existing) => existing.key === source.key);
    if (row) row.documents.push(document.id);
    else rows.push({ ...source, documents: [document.id], status: "waiting", note: "" });
  }
  state.sources = rows.filter((source) => source.documents.length || source.status === "attached");
}

const outcomeOf = ({ summary, workbook, workbookName, sidecar, sidecarName, missingSources, state, sourceFailures }) =>
  ({ summary, workbook, workbookName, sidecar, sidecarName, missingSources: missingSources ?? [], state, sourceFailures: sourceFailures ?? [] });

async function verify(document, signal) {
  document.status = "running"; document.phase = "read"; document.fraction = 0; document.now = [];
  document.done = document.total = 0; document.highlights = []; document.result = null; document.error = "";
  nowLine(document, "Reading the document…");
  if (!state.documents.some((other) => other.status === "running" && other.id === state.selected)) state.selected = document.id;
  emit();
  try {
    const result = await operations("run", {
      documents: [{ name: document.name, bytes: document.bytes.slice() }],
      settings: runSettings(), llm: state.settings.run_mode === "free" || state.settings.local_only ? undefined : providerForRun(),
      corpus: corpusForRun(),
    }, { signal, progress: (event) => progressEvent(document, event) });
    const outcome = result.documents[0];
    document.result = { runId: result.runId, ...outcomeOf(outcome) };
    document.status = "done"; document.phase = null; document.fraction = 1; document.now = ["Done."];
    summaryHighlights(document, document.result);
    mergeSources(document, document.result.missingSources);
  } catch (error) {
    if (signal.aborted) { document.status = "stopped"; document.now = ["Stopped."]; highlight(document, "Stopped before it finished.", "warn"); }
    else {
      document.status = "failed"; document.error = errorText(error);
      document.now = [document.error]; highlight(document, document.error, "err");
    }
  }
  save(); emit();
}

const runSettings = () => ({ ...state.settings,
  parallel_files: state.settings.parallel_files === "auto" ? "auto" : Number(state.settings.parallel_files) });
const errorText = (error) => error?.status === 500 || !error?.message
  ? "The verifier stopped with an internal error on this document. No workbook was written."
  : error.message;

function runBlocker() {
  const { settings, documents } = state;
  if (!documents.length) return "Add at least one .docx file.";
  if (!settings.pdf_input && documents.some((document) => /\.pdf$/iu.test(document.name)))
    return "Turn on experimental PDF input in Settings, under Advanced, or remove the PDF files.";
  if (settings.local_only && !corpusReady()) return "Local only needs the A2AJ cases and legislation downloaded. Download them in Settings, under A2AJ local corpus.";
  if (!settings.local_only && settings.run_mode !== "free" && !providerReady())
    return `${RUN_MODES.find((mode) => mode.value === settings.run_mode).label} needs an AI provider. Connect one in Settings, or choose Free mode.`;
  return "";
}

async function run() {
  if (state.running) return;
  const blocker = runBlocker();
  if (blocker) return notice(blocker);
  controller = new AbortController();
  Object.assign(state, { running: true, stopping: false, startedAt: performance.now(), notice: "" });
  eta.reset();
  for (const document of state.documents) Object.assign(document, { status: "queued", phase: null, fraction: 0,
    now: [], highlights: [], result: null, error: "" });
  state.sources = [];
  state.selected = state.documents[0].id; state.lower = "highlights";
  emit();
  const queue = [...state.documents], width = Math.min(queue.length, concurrency());
  await Promise.all(Array.from({ length: width }, async () => {
    while (queue.length && !controller.signal.aborted) await verify(queue.shift(), controller.signal);
  }));
  for (const document of queue) { document.status = "stopped"; document.now = ["Not started."]; }
  Object.assign(state, { running: false, stopping: false });
  if (state.sources.some((source) => source.status === "waiting")) state.lower = "sources";
  save(); emit();
}
const concurrency = () => state.settings.parallel_files === "auto" ? 2 : Number(state.settings.parallel_files);
function stop() {
  if (!state.running) return;
  state.stopping = true; controller.abort(); emit();
}

function download(name, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function downloadResult(document) {
  const { workbook, workbookName, sidecar, sidecarName } = document.result;
  download(workbookName, workbook, XLSX);
  if (sidecar) download(sidecarName, JSON.stringify(sidecar, null, 2), "application/json");
}

// ---------------------------------------------------------------- time remaining
// The desktop app's estimate (gui.py _eta_text): shown only once 25 footnotes and 90 seconds of
// analysis have been measured, from the slower of the whole-run and recent rates, padded for the
// phases after analysis, quick to believe a slowdown and slow to believe a speedup.
const eta = {
  started: 0, samples: [], smoothed: null,
  reset() { this.started = 0; this.samples = []; this.smoothed = null; },
};
function noteFootnotes() {
  const done = state.documents.reduce((sum, document) => sum + (document.phase === "analyze" ? document.done
    : document.total && document.status !== "queued" ? document.total : 0), 0);
  eta.started ||= performance.now();
  eta.samples = [...eta.samples, [done, performance.now()]].slice(-25);
}
function etaText() {
  const analyzing = state.documents.filter((document) => document.status === "running" && document.phase === "analyze");
  if (!eta.started || !analyzing.length) return "";
  const known = state.documents.reduce((sum, document) => sum + (document.total && document.phase === "analyze" ? document.total : 0), 0);
  const done = analyzing.reduce((sum, document) => sum + document.done, 0);
  const span = (performance.now() - eta.started) / 1000;
  if (done < 25 || span < 90 || !known) return "";
  const rates = [done / span];
  if (eta.samples.length >= 8) {
    const [[firstDone, firstAt]] = eta.samples, [lastDone, lastAt] = eta.samples.at(-1);
    if (lastDone > firstDone && lastAt > firstAt) rates.push((lastDone - firstDone) / ((lastAt - firstAt) / 1000));
  }
  const remaining = (known - done) / Math.max(Math.min(...rates), 1e-6) * 1.3;
  eta.smoothed = eta.smoothed === null ? remaining
    : eta.smoothed + (remaining > eta.smoothed ? 0.5 : 0.02) * (remaining - eta.smoothed);
  const seconds = Math.max(0, Math.round(eta.smoothed));
  if (seconds < 90) return `about ${Math.max(seconds, 10)} sec left`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `about ${minutes} min left` : `about ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min left`;
}

// ---------------------------------------------------------------- CanLII step
let watcher = null, attaching = Promise.resolve();
async function resumeFolder(handle) {
  if (await folderPermission(handle) === "granted") startWatching(handle);
  else state.folder = { name: handle.name, handle, ask: true };
}
function startWatching(handle) {
  watcher?.stop();
  watcher = watchFolder(handle, {
    offer: (files, tried) => offerPdfs(files, tried),
    lost: (error) => {
      watcher = null;
      state.folder = error ? null : { name: handle.name, handle, ask: true };
      if (error) notice(`Stopped watching the folder. ${errorText(error)}`); else emit();
    },
  });
  state.folder = { name: handle.name, handle, watching: true };
  emit();
}
async function chooseFolder() {
  if (state.folder?.ask) {
    if (await requestFolderAccess(state.folder.handle) === "granted") startWatching(state.folder.handle);
    return;
  }
  if (watcher) { watcher.stop(); watcher = null; state.folder = null; void keep("folder", undefined); emit(); return; }
  let chosen;
  try { chosen = await chooseWatchedFolder("alr-downloads"); }
  catch (error) { return notice(errorText(error)); }
  if (!chosen) return;
  if (chosen.files) return void offerPdfs(chosen.files, () => {});
  void keep("folder", chosen.handle);
  startWatching(chosen.handle);
}
/** Each new PDF goes to every document still waiting for a source; the verifier attaches it to the
 *  source its opening citation names, refuses a PDF of another decision, and checks the affected rows again. */
function offerPdfs(files, tried) {
  attaching = attaching.then(async () => {
    for (const file of files) {
      const waiting = state.documents.filter((document) => document.result?.state && state.sources.some((source) =>
        source.status !== "attached" && source.documents.includes(document.id)));
      if (!waiting.length || state.running) return;
      tried(file);
      const pdf = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
      let refusal = "";
      for (const document of waiting) {
        let outcome;
        try { outcome = await operations("attachSource", { runId: document.result.runId, state: document.result.state,
          pdf: { ...pdf, bytes: pdf.bytes.slice() } }); }
        catch (error) { refusal ||= errorText(error); continue; }
        if (outcome.refused) refusal ||= outcome.refused;
        else { applyAttachment(document, file, outcome); refusal = null; }
      }
      // A PDF no document waits for stays where it is; say why once, beside the folder.
      state.folderNote = !refusal ? "" : refusal.includes(file.name) ? refusal : `${file.name} was not added. ${refusal}`;
      save(); emit();
    }
  }).catch((error) => notice(errorText(error)));
  return attaching;
}
function applyAttachment(document, file, outcome) {
  const updated = outcome.documents[0], before = document.result.summary;
  document.result = { ...document.result, ...outcomeOf(updated) };
  const source = state.sources.find((row) => row.key === outcome.key);
  if (source) { source.status = "attached"; source.note = file.name; }
  const gained = updated.summary.perfect + updated.summary.partial - before.perfect - before.partial;
  highlight(document, `Added ${file.name} and checked its quotations again${gained > 0 ? `: ${gained} more found` : ""}.`, "ok");
}

// ---------------------------------------------------------------- page
const drag = { depth: 0 };
function App() {
  useVersion();
  useEffect(() => {
    void load();
    const enter = (event) => { if ([...(event.dataTransfer?.types ?? [])].includes("Files")) { event.preventDefault(); drag.depth += 1; emit(); } };
    const over = (event) => { if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault(); };
    const leave = () => { drag.depth = Math.max(0, drag.depth - 1); emit(); };
    const drop = (event) => { event.preventDefault(); drag.depth = 0; state.view = "verify"; void addFiles(event.dataTransfer.files); };
    addEventListener("dragenter", enter); addEventListener("dragover", over); addEventListener("dragleave", leave); addEventListener("drop", drop);
    // The provider and corpus panels say when what they hold changes (a provider connected, a corpus downloaded).
    addEventListener("alr-change", emit);
    const tick = setInterval(() => { if (state.running) emit(); }, 1000);
    return () => { removeEventListener("dragenter", enter); removeEventListener("dragover", over);
      removeEventListener("dragleave", leave); removeEventListener("drop", drop); removeEventListener("alr-change", emit); clearInterval(tick); };
  }, []);
  return <div className="app">
    <header className="masthead">
      <div className="brand">
        <h1>ALR Quote Verifier</h1>
        <p>Citation links and quotation checking for law review editing</p>
      </div>
      <nav className="tabs" aria-label="Views">
        {[["verify", "Verify"], ["settings", "Settings"]].map(([value, label]) =>
          <button key={value} type="button" aria-pressed={state.view === value} className="tab"
            onClick={() => { state.view = value; emit(); }}>{label}</button>)}
      </nav>
    </header>
    <main className={state.view === "verify" ? "verify" : "settings"}>
      {state.view === "verify" ? <Verify /> : <Settings />}
    </main>
  </div>;
}

function Verify() {
  return <>
    <Documents />
    <Activity />
    <RunBar />
  </>;
}

const caption = (text) => <h2 className="caption">{text}</h2>;
const size = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const GLYPH = { ready: null, queued: "◦", running: null, done: "✓", failed: "✗", stopped: "–", interrupted: "–" };

function Documents() {
  const { documents, running } = state;
  return <section className={`card documents${drag.depth ? " dragging" : ""}`} aria-label="Documents">
    <div className="card-head">
      {caption("Documents")}
      <span className="muted">{documents.length ? `${documents.length} document${documents.length === 1 ? "" : "s"}` : "No files"}</span>
    </div>
    {documents.length ? <ul className="doc-list">
      {documents.map((document) => <li key={document.id} aria-current={document.id === state.selected || undefined}
        className={`doc-row status-${document.status}`}>
        <FileText aria-hidden className="doc-icon" />
        <button type="button" className="doc-name" onClick={() => { state.selected = document.id; state.lower = "highlights"; emit(); }}
          title={document.name}>{document.name}</button>
        <span className="doc-meta">{document.status === "running" ? <span className="spinner" aria-label="Verifying" />
          : document.status === "queued" ? "Queued" : GLYPH[document.status] ? <span className={`glyph ${document.status}`}>{GLYPH[document.status]}</span> : size(document.size)}</span>
        <button type="button" className="icon-button" aria-label={`Remove ${document.name}`} disabled={running}
          onClick={() => removeDocument(document.id)}><X aria-hidden /></button>
      </li>)}
    </ul> : <button type="button" className="drop" onClick={pickFiles}>
      <FilePlus2 aria-hidden />
      <span className="drop-title">Drop .docx files here</span>
      <span className="muted">{state.settings.pdf_input ? "or choose .docx or PDF files" : "or choose them from your computer"}</span>
    </button>}
    <div className="card-foot">
      <button type="button" className="button secondary" onClick={pickFiles} disabled={running}><FilePlus2 aria-hidden />Add files</button>
      <button type="button" className="button quiet" onClick={clearDocuments} disabled={running || !documents.length}>Clear</button>
    </div>
  </section>;
}

function Activity() {
  const { documents } = state;
  const selected = documents.find((document) => document.id === state.selected);
  const waiting = state.sources.filter((source) => source.status !== "attached").length;
  return <section className="card activity" aria-label="Activity">
    <div className="card-head">
      {caption("Activity")}
      {selected?.result?.workbook ? <button type="button" className="button secondary small" onClick={() => downloadResult(selected)}>
        <Download aria-hidden />Download workbook</button> : <span className="muted">{selected ? statusText(selected) : ""}</span>}
    </div>
    {selected ? <>
      <div className="doc-title">
        <span title={selected.name}>{selected.name}</span>
        {documents.length > 1 && <span className="muted">article {documents.indexOf(selected) + 1} of {documents.length}</span>}
      </div>
      <div className="overview">
        <Phases document={selected} />
        <Counts document={selected} />
      </div>
      <div className="lower">
        <div className="segments" role="tablist">
          <button type="button" role="tab" aria-selected={state.lower === "highlights"} onClick={() => { state.lower = "highlights"; emit(); }}>Highlights</button>
          <button type="button" role="tab" aria-selected={state.lower === "sources"} onClick={() => { state.lower = "sources"; emit(); }}>
            Sources to add{waiting ? <span className="badge">{waiting}</span> : null}</button>
        </div>
        {state.lower === "highlights" ? <Highlights document={selected} /> : <Sources />}
      </div>
    </> : <Welcome />}
  </section>;
}
const statusText = (document) => ({ ready: "Ready to verify", queued: "Queued", running: "Verifying", done: "Finished",
  failed: "Could not finish", stopped: "Stopped", interrupted: "Interrupted by a reload — run again" })[document.status];

function Counts({ document }) {
  const summary = document.result?.summary;
  return <div className="counts">
    {COUNTS.map(([key, label]) => <div key={key} className={`count ${key}`}>
      <span className="count-value">{summary ? summary[key] : "—"}</span>
      <span className="count-label">{label}</span>
    </div>)}
    <p className="count-line muted">{summary ? `${summary.footnotes} footnotes · ${summary.parts} citation parts · ${summary.quotes} quotations`
      : "Counts appear when the quotations are checked."}</p>
  </div>;
}

function Phases({ document }) {
  const index = PHASES.findIndex(([key]) => key === document.phase);
  const finished = document.status === "done";
  return <div className="phases">
    <ol>
      {PHASES.map(([key, label], at) => {
        const phase = finished || (index >= 0 && at < index) ? "done" : at === index && document.status === "running" ? "active" : "pending";
        return <li key={key} className={`phase ${phase}`}>
          <span className="phase-mark" aria-hidden>{phase === "done" ? <Check /> : phase === "active" ? <span className="spinner" /> : <span className="dot" />}</span>
          <span className="phase-name">{label}</span>
          <span className="phase-detail">{phase === "active" && document.total ? `${document.done} of ${document.total}` : ""}</span>
        </li>;
      })}
    </ol>
    <div className="now" aria-live="polite">
      {[0, 1].map((line) => <p key={line}>{document.now[line] ?? " "}</p>)}
    </div>
  </div>;
}

function Highlights({ document }) {
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [document.highlights.length]);
  return <div className="feed" role="tabpanel">
    {document.highlights.length ? document.highlights.map((item, at) => <p key={at} className={`feed-line ${item.tone}`}>
      <span className="feed-dot" aria-hidden />{item.text}</p>)
      : <p className="feed-line dim"><span className="feed-dot" aria-hidden />{document.status === "ready" || document.status === "interrupted"
        ? "Press Run verification to check this document." : "Nothing to report yet."}</p>}
    <span ref={end} />
  </div>;
}

function Sources() {
  const { sources, folder, documents } = state;
  const name = (id) => documents.find((document) => document.id === id)?.name ?? "";
  return <div className="sources" role="tabpanel">
    <p className="muted">A2AJ could not supply these sources. Open each on CanLII and save its PDF in the watched folder; the verifier attaches it and checks its quotations again.</p>
    <div className="folder-row">
      <button type="button" className={`button ${folder?.watching ? "quiet" : "secondary"}`} onClick={() => void chooseFolder()}>
        <FolderSearch aria-hidden />{folder?.watching ? "Stop watching" : folder?.ask ? `Allow ${folder.name} again` : "Watch Downloads folder"}</button>
      {state.folderNote ? <span className="muted alert" title={state.folderNote}>{state.folderNote}</span>
        : folder?.watching ? <span className="watching">Watching {folder.name}</span>
        : <span className="muted">{folder?.ask ? "The browser asks again for a kept folder after a reload."
          : globalThis.showDirectoryPicker ? "" : "This browser reads the folder once, when you choose it."}</span>}
    </div>
    {sources.length ? <ul className="source-list">
      {sources.map((source) => <li key={source.key} className={`source ${source.status}`}>
        <span className="source-mark" aria-hidden>{source.status === "attached" ? <Check /> : <span className="dot" />}</span>
        <span className="source-text">
          <span className="source-citation">{source.citation}</span>
          {(() => { const text = source.status === "attached" ? `Added from ${source.note}`
            : `Cited in ${source.documents.map(name).join(", ")}`; return <span className="muted" title={text}>{text}</span>; })()}
        </span>
        {source.status !== "attached" && (source.canliiPdfUrl || source.canliiPageUrl) &&
          <a className="button secondary small" href={source.canliiPdfUrl ?? source.canliiPageUrl} target="_blank" rel="noreferrer">
            CanLII<ExternalLink aria-hidden /></a>}
      </li>)}
    </ul> : <p className="feed-line dim"><span className="feed-dot" aria-hidden />{documents.some((document) => document.result)
      ? "Every source was supplied. Nothing to add." : "Sources A2AJ cannot supply are listed here after a run."}</p>}
  </div>;
}

function Welcome() {
  return <div className="welcome">
    <h3>Check a law review article's citations and quotations</h3>
    <ol className="steps">
      <li><span className="step">1</span><div><strong>Add your documents</strong>
        <p>Drop .docx files on this window or choose them under Documents. Each document gets its own Excel workbook, [CHECKED] and its name.</p></div></li>
      <li><span className="step">2</span><div><strong>Choose how footnotes are read</strong>
        <p>Free mode reads them without AI and needs nothing more. The AI modes need a provider, connected in Settings.</p></div></li>
      <li><span className="step">3</span><div><strong>Add what A2AJ could not supply</strong>
        <p>After a run, Sources to add links each missing decision on CanLII. Save its PDF in your Downloads folder and the verifier checks its quotations again.</p></div></li>
    </ol>
  </div>;
}

function RunBar() {
  const { documents, running, stopping, settings } = state;
  const finished = documents.filter((document) => ["done", "failed", "stopped"].includes(document.status)).length;
  const active = documents.filter((document) => document.status === "running");
  const fraction = documents.length ? documents.reduce((sum, document) => sum + (["done", "failed"].includes(document.status)
    ? 1 : document.fraction), 0) / documents.length : 0;
  const results = documents.filter((document) => document.result?.workbook);
  const headline = running ? documents.length === 1 ? `Verifying ${documents[0].name}`
    : `${documents.length - finished} of ${documents.length} in progress${active.length > 1 ? ` · ${active.length} at once` : ""} · ${finished} finished`
    : results.length ? `${results.length} workbook${results.length === 1 ? "" : "s"} ready` : "Ready";
  const sub = state.notice || (running ? stopping ? "Stopping after the current step…" : [`${Math.floor(fraction * 100)}% done`, etaText()].filter(Boolean).join(" · ")
    : settings.fn_filter.trim() ? `Only footnotes ${settings.fn_filter.trim()} will be verified (Footnote filter in Settings).`
      : documents.length ? `${RUN_MODES.find((mode) => mode.value === (settings.local_only ? "free" : settings.run_mode)).label} mode. Change it in Settings.`
        : "Add documents, then press Run verification.");
  return <section className={`runbar${running ? " running" : ""}`} aria-label="Run">
    <div className="run-status">
      <p className="headline">{headline}</p>
      <p className={`sub${state.notice ? " alert" : ""}`}>{sub}</p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>
    </div>
    <div className="run-actions">
      <button type="button" className="button secondary" disabled={results.length < 2 || running}
        onClick={() => results.forEach(downloadResult)}><Download aria-hidden />Download all</button>
      <button type="button" className="button secondary" disabled={!running || stopping} onClick={stop}><Square aria-hidden />Stop</button>
      <button type="button" className="button primary" disabled={running} onClick={() => void run()}>
        {running ? <span className="spinner light" /> : <Play aria-hidden />}{running ? "Running…" : "Run verification"}</button>
    </div>
  </section>;
}

// ---------------------------------------------------------------- settings
function Choice({ legend, name, options, columns = false }) {
  return <fieldset className="choice">
    <legend>{legend}</legend>
    <div className={`option-grid${columns ? " two" : ""}`}>
      {options.map((option) => <label key={option.value} className="option">
        <input type="radio" name={name} checked={state.settings[name] === option.value} onChange={() => setSetting(name, option.value)} />
        <span><span className="option-label">{option.label}</span><span className="option-detail">{option.detail}</span></span>
      </label>)}
    </div>
  </fieldset>;
}
function Toggle({ name, label, detail, disabled }) {
  return <label className="option">
    <input type="checkbox" checked={state.settings[name]} disabled={disabled} onChange={(event) => setSetting(name, event.target.checked)} />
    <span><span className="option-label">{label}</span><span className="option-detail">{detail}</span></span>
  </label>;
}
function Group({ title, children }) {
  return <section className="card group" aria-label={title}>{caption(title)}{children}</section>;
}

function Settings() {
  const { settings } = state;
  return <div className="settings-columns">
    <div className="settings-column">
      <Group title="AI provider">
        <p className="muted">AI reads footnotes in High accuracy, Economy and Ultra economy modes. Free mode makes no AI calls.</p>
        <ProviderPanel />
      </Group>
      <Group title="Processing">
        <Choice legend="Mode" name="run_mode" options={RUN_MODES} />
        <Choice legend="Supra linking" name="supra_linking" options={SUPRA_LINKING} />
        <label className="field">
          <span className="option-label">Articles at once</span>
          <select value={settings.parallel_files} onChange={(event) => setSetting("parallel_files", event.target.value)}>
            {PARALLEL_FILES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <span className="option-detail">How many documents verify at the same time. Auto verifies two at once.</span>
        </label>
        <Toggle name="a2aj" label="Verify quotes against source text (A2AJ)"
          detail="Fetches judgment and legislation text from A2AJ, a free public service, and checks quoted passages against it. Turning this off skips quote verification." />
      </Group>
      <Group title="Sources">
        <Toggle name="us_uk_case_lookup" label="Find US/UK case URLs (free public sources)" disabled={settings.local_only}
          detail={settings.local_only ? "Unavailable while Local only is on." : "Looks up links for US and UK cases in free public sources."} />
      </Group>
    </div>
    <div className="settings-column">
      <Group title="A2AJ local corpus">
        <CorpusPanel />
      </Group>
      <Group title="Local only">
        <Toggle name="local_only" label="Run entirely locally"
          detail="Makes no network requests to any provider. It requires the A2AJ cases and legislation downloaded ahead of time, uses Free mode, and US/UK cases won't work." />
      </Group>
      <Group title="Output">
        <Choice legend="Excel detail" name="export_detail" options={EXPORT_DETAIL} />
      </Group>
      <Group title="Advanced">
        <Choice legend="Text fragments" name="frag_mode" options={FRAG_MODES} />
        <Choice legend="Quote context" name="proposition_mode" options={PROPOSITION_MODES} />
        <label className="field">
          <span className="option-label">Footnote filter</span>
          <input type="text" value={settings.fn_filter} placeholder="1,4,10-12" spellCheck={false}
            onChange={(event) => setSetting("fn_filter", event.target.value)} />
          <span className="option-detail">Only these footnotes are verified. Leave it empty to verify every footnote.</span>
        </label>
        <Toggle name="llm_cache" label="Cache model responses (LLM cache)"
          detail="Keeps each AI answer in this browser, so running the same footnotes again costs nothing." />
        <Toggle name="pdf_input" label="Enable experimental PDF input"
          detail="Allows PDF articles to be added. PDF mode reads bottom-of-page footnotes with same-page references, not endnotes." />
      </Group>
      <div className="settings-foot">
        <button type="button" className="button quiet" onClick={() => {
          state.settings = { ...DEFAULT_SETTINGS }; save(); emit();
        }}>Reset all settings to defaults</button>
      </div>
    </div>
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);
