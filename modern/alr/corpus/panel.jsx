// Settings › A2AJ local corpus: A2AJ's court decisions and legislation (Hugging Face Parquet files,
// one per court or jurisdiction) downloaded into a folder the user picks. Beaver's corpus primitive
// (backend/src/lib/a2ajCorpus.ts) downloads, resumes, verifies and updates them; the run receives the
// folder (corpusForRun) and Beaver's A2AJ source reads it in the runtime Worker (a2ajParquet.ts).
// In the desktop app the server's shared corpus folder is given as globalThis.ALR_CORPUS_FOLDER.
import { useSyncExternalStore } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
import { FolderOpen, RefreshCw, Download, Square } from "lucide-react";
import { A2AJ_KINDS, a2ajBytesToDownload, a2ajCorpusStatus, a2ajCourtStale, directoryA2AJFolder, fetchA2AJSnapshot,
  installA2AJCourts } from "../../../../backend/src/lib/a2ajCorpus";
import { keep, kept } from "../store.mjs";
import { courtName } from "./courts.mjs";

const KIND_TITLES = { cases: "Court decisions", laws: "Statutes and regulations" };
const serverFolder = () => globalThis.ALR_CORPUS_FOLDER ?? null;

// ---------------------------------------------------------------- state
const state = {
  handle: null, // the picked folder (FileSystemDirectoryHandle)
  access: "none", // none | prompt | granted
  snapshots: null, // { cases, laws }: the dataset revisions last read from Hugging Face
  status: null, // { cases, laws }: a2ajCorpusStatus per kind
  selected: new Set(), // "cases/SCC"
  checking: false, checkedAt: 0,
  job: null, // { court, downloaded, toDownload, controller }
  message: "", failed: false,
};
let version = 0;
const listeners = new Set();
function emit() {
  version += 1;
  for (const listener of listeners) listener();
  window.dispatchEvent(new Event("alr-change"));
}
const useVersion = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  () => version);

const folder = () => serverFolder() ?? (state.handle && state.access === "granted" ? directoryA2AJFolder(state.handle) : null);
const installedCourts = (kind) => state.status?.[kind]?.courts.filter((court) => court.installed) ?? [];

/** Whether the folder holds court decisions and legislation, as Local only needs. */
export const corpusReady = () => !!folder() && A2AJ_KINDS.every((kind) => installedCourts(kind).length > 0);
/** The folder the run reads, when it holds any court: the picked directory, which the runtime Worker
 *  can open. The desktop server reads its own folder. */
export const corpusForRun = () => !serverFolder() && state.handle && state.access === "granted" &&
  A2AJ_KINDS.some((kind) => installedCourts(kind).length) ? state.handle : undefined;

async function refresh() {
  const target = folder();
  if (!target) { state.status = null; emit(); return; }
  try {
    const entries = await Promise.all(A2AJ_KINDS.map(async (kind) =>
      [kind, await a2ajCorpusStatus(target, kind, state.snapshots?.[kind] ?? null)]));
    state.status = Object.fromEntries(entries);
  } catch {
    state.status = null;
    state.message = "The folder could not be read. Choose it again."; state.failed = true;
  }
  emit();
}

async function load() {
  const [handle, snapshots, selected] = await Promise.all([kept("corpusFolder"), kept("corpusSnapshots"), kept("corpusSelected")]);
  state.snapshots = snapshots ?? null;
  state.checkedAt = snapshots?.checkedAt ?? 0;
  if (selected) state.selected = new Set(selected);
  if (handle && !serverFolder()) {
    state.handle = handle;
    state.access = await handle.queryPermission?.({ mode: "readwrite" }).catch(() => "prompt") ?? "prompt";
  }
  await refresh().catch(() => {});
}
if (typeof window !== "undefined") void load();

const saveSelection = () => void keep("corpusSelected", [...state.selected]);

async function chooseFolder() {
  try {
    const handle = await window.showDirectoryPicker({ id: "alr-a2aj-corpus", mode: "readwrite" });
    state.handle = handle; state.access = "granted"; state.message = ""; state.failed = false;
    void keep("corpusFolder", handle);
    await refresh();
    // A new folder lists every court to choose from: the dataset's current revision is read now.
    await checkForUpdates();
  } catch (error) {
    if (error?.name !== "AbortError") { state.message = "The folder could not be opened."; state.failed = true; emit(); }
  }
}

async function allowAccess() {
  state.access = await state.handle.requestPermission({ mode: "readwrite" }).catch(() => "prompt");
  emit();
  await refresh();
}

async function checkForUpdates() {
  state.checking = true; state.message = ""; state.failed = false; emit();
  try {
    const [cases, laws] = await Promise.all(A2AJ_KINDS.map((kind) => fetchA2AJSnapshot(kind, (url, init) => fetch(url, init))));
    state.snapshots = { cases, laws, checkedAt: Date.now() };
    state.checkedAt = state.snapshots.checkedAt;
    void keep("corpusSnapshots", state.snapshots);
    // Nothing chosen yet: every court is offered, so Local only has what it needs.
    if (!state.selected.size && !A2AJ_KINDS.some((kind) => installedCourts(kind).length))
      for (const kind of A2AJ_KINDS) for (const file of state.snapshots[kind].files) state.selected.add(`${kind}/${file.path.split("/")[0]}`);
    else for (const kind of A2AJ_KINDS) for (const court of installedCourts(kind)) state.selected.add(`${kind}/${court.court}`);
    saveSelection();
    await refresh();
  } catch {
    state.message = "Hugging Face could not be reached to list the corpus. Check the connection and try again.";
    state.failed = true;
  } finally { state.checking = false; emit(); }
}

/** What applying the selection does: bytes to fetch, courts to update, courts to remove. */
function plan() {
  const result = { bytes: 0, download: 0, update: 0, remove: [] };
  if (!state.status) return result;
  for (const kind of A2AJ_KINDS) {
    const status = state.status[kind], wanted = status.courts.filter((court) => state.selected.has(`${kind}/${court.court}`));
    result.bytes += a2ajBytesToDownload(status, wanted.map((court) => court.court));
    for (const court of wanted) {
      if (!court.remote) continue;
      if (!court.installed) result.download += 1;
      else if (a2ajCourtStale(court)) result.update += 1;
    }
    for (const court of status.courts) if (court.installed && !state.selected.has(`${kind}/${court.court}`)) result.remove.push(court);
  }
  return result;
}

async function apply() {
  const target = folder();
  if (!target || state.job) return;
  const controller = new AbortController();
  state.job = { court: "", downloaded: 0, toDownload: plan().bytes, controller };
  state.message = ""; state.failed = false; emit();
  let completed = 0;
  try {
    for (const kind of A2AJ_KINDS) {
      const snapshot = state.snapshots?.[kind];
      if (!snapshot) continue;
      const courts = state.status[kind].courts.map((court) => court.court);
      await installA2AJCourts(target, snapshot, courts.filter((court) => state.selected.has(`${kind}/${court}`)), {
        fetch: (url, init) => fetch(url, init), sha256: () => sha256.create(), signal: controller.signal,
        remove: courts.filter((court) => !state.selected.has(`${kind}/${court}`)),
        progress: ({ court, downloaded }) => {
          state.job = { ...state.job, court, downloaded: completed + downloaded };
          emit();
        },
      });
      completed = state.job.downloaded;
      await refresh();
    }
    state.message = "The selected courts are downloaded and current.";
  } catch (error) {
    if (controller.signal.aborted) state.message = "Stopped. Downloading again continues each court where it stopped.";
    else { state.message = error?.message ?? "The download did not finish."; state.failed = true; }
  } finally {
    state.job = null;
    await refresh().catch(() => {});
    emit();
  }
}

// ---------------------------------------------------------------- view
const size = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB`
  : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
const when = (time) => new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function courtState(court, selected) {
  if (court.installed && !court.remote) return "Downloaded";
  if (court.installed && a2ajCourtStale(court)) return selected ? "Update available" : "Will be removed";
  if (court.installed) return selected ? "Downloaded" : "Will be removed";
  if (court.partial) return `${Math.round((court.partial / court.remote.size) * 100)}% downloaded`;
  return "";
}

function KindList({ kind }) {
  const courts = state.status?.[kind]?.courts ?? [];
  const keys = courts.map((court) => `${kind}/${court.court}`);
  const chosen = keys.filter((key) => state.selected.has(key)).length;
  const installed = courts.filter((court) => court.installed).length;
  const toggle = (key, on) => { on ? state.selected.add(key) : state.selected.delete(key); saveSelection(); emit(); };
  return <details className="corpus-kind">
    <summary>
      <span className="corpus-kind-title">{KIND_TITLES[kind]}</span>
      <span className="muted">{installed} of {courts.length} downloaded</span>
    </summary>
    <label className="corpus-row corpus-all">
      <input type="checkbox" checked={!!courts.length && chosen === courts.length} disabled={!!state.job || !courts.length}
        ref={(input) => { if (input) input.indeterminate = chosen > 0 && chosen < courts.length; }}
        onChange={(event) => { for (const key of keys) event.target.checked ? state.selected.add(key) : state.selected.delete(key); saveSelection(); emit(); }} />
      <span className="corpus-name">All {KIND_TITLES[kind].toLowerCase()}</span>
      <span className="corpus-size">{size(courts.reduce((total, court) => total + (court.remote ?? court.installed).size, 0))}</span>
      <span className="corpus-state" />
    </label>
    {courts.map((court) => {
      const key = `${kind}/${court.court}`, selected = state.selected.has(key);
      return <label key={key} className="corpus-row">
        <input type="checkbox" checked={selected} disabled={!!state.job} onChange={(event) => toggle(key, event.target.checked)} />
        <span className="corpus-name"><span className="corpus-code">{court.court}</span>{courtName(court.court)}</span>
        <span className="corpus-size">{size((court.remote ?? court.installed).size)}</span>
        <span className={`corpus-state${court.installed && !a2ajCourtStale(court) && selected ? " ok" : ""}`}>{courtState(court, selected)}</span>
      </label>;
    })}
  </details>;
}

export function CorpusPanel() {
  useVersion();
  const desktop = !!serverFolder(), target = folder(), job = state.job;
  const steps = plan();
  const pending = steps.bytes > 0 || steps.remove.length > 0;
  const summary = !target ? "" : [
    steps.bytes ? `Downloads ${size(steps.bytes)}${steps.update ? `, including ${steps.update} update${steps.update === 1 ? "" : "s"}` : ""}.` : "",
    steps.remove.length ? `Removes ${steps.remove.map((court) => court.court).join(", ")} (${size(steps.remove.reduce((total, court) => total + court.installed.size, 0))}).` : "",
  ].filter(Boolean).join(" ") || (A2AJ_KINDS.some((kind) => state.status?.[kind]?.courts.some((court) => court.remote))
    ? "Everything selected is downloaded and current." : "Check for updates to list every court.");
  const fraction = job?.toDownload ? Math.min(job.downloaded / job.toDownload, 1) : 0;
  return <div className="corpus">
    <p className="muted">Downloads A2AJ's court decisions and legislation from Hugging Face into a folder on this computer.
      Verification reads the downloaded courts from the folder and asks A2AJ only for the rest. Local only uses the folder alone.</p>
    <div className="corpus-folder">
      <FolderOpen aria-hidden />
      <span className="corpus-folder-name">{desktop ? "The shared legal data folder on this computer"
        : state.handle ? state.handle.name : "No folder chosen"}</span>
      {!desktop && state.handle && state.access !== "granted" &&
        <button type="button" className="button secondary small" onClick={() => void allowAccess()}>Allow access</button>}
      {!desktop && <button type="button" className="button secondary small" disabled={!!job}
        onClick={() => void chooseFolder()}>{state.handle ? "Change folder" : "Choose folder"}</button>}
    </div>
    {target && state.status && <>
      <div className="corpus-lists">
        {A2AJ_KINDS.map((kind) => <KindList key={kind} kind={kind} />)}
      </div>
      <div className="corpus-actions">
        <span className="corpus-summary muted">{summary}</span>
        <button type="button" className="button quiet small" disabled={state.checking || !!job} onClick={() => void checkForUpdates()}>
          {state.checking ? <span className="spinner" /> : <RefreshCw aria-hidden />}Check for updates</button>
        {job
          ? <button type="button" className="button secondary small" onClick={() => job.controller.abort()}><Square aria-hidden />Stop</button>
          : <button type="button" className="button primary small corpus-apply" disabled={!pending || !state.snapshots}
            onClick={() => void apply()}><Download aria-hidden />Download selected</button>}
      </div>
      <div className="corpus-progress" aria-hidden={!job}>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <span style={{ transform: `scaleX(${fraction})` }} />
        </div>
        <span className="muted">{job ? `${job.court ? `${job.court}: ` : ""}${size(job.downloaded)} of ${size(job.toDownload)}`
          : state.checkedAt ? `Corpus revision checked ${when(state.checkedAt)}.` : " "}</span>
      </div>
    </>}
    <p className={`corpus-message${state.failed ? " failed" : ""}`} aria-live="polite">{state.message || " "}</p>
  </div>;
}

// The panel's own layout, in the page's design language (alr/styles.css variables).
if (typeof document !== "undefined" && !document.getElementById("alr-corpus-styles")) {
  const style = document.createElement("style");
  style.id = "alr-corpus-styles";
  style.textContent = `
.corpus { display: grid; gap: 10px; min-width: 0; }
.corpus > p.muted { font-size: 13px; }
.corpus-folder { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(0, 0, 0, 0.12); }
.corpus-folder svg { color: var(--accent); }
.corpus-folder-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.corpus-lists { display: grid; gap: 6px; }
.corpus-kind { border: 1px solid var(--line); border-radius: 10px; background: rgba(0, 0, 0, 0.12); }
.corpus-kind summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 9px 12px; cursor: pointer; list-style-position: inside; }
.corpus-kind summary .muted { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.corpus-kind-title { font-weight: 600; }
.corpus-kind[open] summary { border-bottom: 1px solid var(--line); }
.corpus-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) 56px 112px; align-items: center; gap: 10px; padding: 5px 12px; cursor: pointer; }
.corpus-row:hover { background: rgba(255, 255, 255, 0.03); }
.corpus-row input { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); }
.corpus-all { border-bottom: 1px solid var(--line); }
.corpus-name { min-width: 0; overflow-wrap: anywhere; }
.corpus-code { display: inline-block; min-width: 76px; margin-right: 8px; color: var(--ink-soft); font-size: 12px; font-weight: 600; letter-spacing: 0.02em; }
.corpus-size { color: var(--ink-muted); font-size: 12.5px; text-align: right; font-variant-numeric: tabular-nums; }
.corpus-state { color: var(--ink-muted); font-size: 12px; text-align: right; white-space: nowrap; }
.corpus-state.ok { color: var(--perfect); }
.corpus-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
.corpus-summary { flex: 1; min-width: 0; font-size: 12.5px; }
.corpus-apply { min-width: 0; }
.corpus-progress { display: grid; gap: 4px; }
.corpus-progress[aria-hidden="true"] .progress { visibility: hidden; }
.corpus-progress .progress { margin-top: 0; }
.corpus-progress .muted { font-size: 12px; font-variant-numeric: tabular-nums; }
.corpus-message { min-height: 1.45em; color: var(--ink-muted); font-size: 12.5px; }
.corpus-message.failed { color: var(--no-match); }
@media (max-width: 520px) { .corpus-row { grid-template-columns: 16px minmax(0, 1fr) 58px; } .corpus-state { display: none; } .corpus-code { min-width: 0; } }
`;
  document.head.append(style);
}
