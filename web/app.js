const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const query = new URLSearchParams(window.location.search);
const SETUP_VERSION = 3;
const mikeMode = query.get("mode") === "mike";
const beaverMode = mikeMode && window.parent !== window;
document.documentElement.classList.toggle("mike-mode", mikeMode);
document.documentElement.classList.toggle("standalone-mode", !mikeMode);
const projectPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const projectId = projectPattern.test(query.get("project") || "") ? query.get("project").toLowerCase() : "";
let defaultSession = "";
if (mikeMode) {
  try {
    defaultSession = sessionStorage.getItem("toa-session") || "";
    if (!/^[0-9a-f]{32}$/.test(defaultSession)) {
      defaultSession = crypto.randomUUID().replaceAll("-", "");
      sessionStorage.setItem("toa-session", defaultSession);
    }
  } catch (error) { /* Session storage is optional. */ }
}
const requestedSession = query.get("session") || "";
const sessionId = /^[0-9a-f]{32}$/.test(requestedSession)
  ? requestedSession
  : (mikeMode ? defaultSession : "");
const readyAttempt = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.get("attempt") || "") ? query.get("attempt") : "";
const sessionKey = mikeMode && sessionId ? `toa-job:${sessionId}` : "";
const requestedJob = mikeMode && /^[0-9a-f]{32}$/.test(query.get("job") || "") ? query.get("job") : "";
let storedJob = "";
try { storedJob = sessionKey ? sessionStorage.getItem(sessionKey) || "" : ""; } catch (error) { /* Session storage is optional. */ }
let currentJob = requestedJob || (!mikeMode && /^[0-9a-f]{32}$/.test(storedJob) ? storedJob : "");
let currentReview = null;
let selectedReviewIndex = 0;
let currentJobState = null;
let activeWorkflow = "";
let manualState = { book_title: "Book of Authorities", entries: [] };
let pollTimer = null;
let reviewSaveTimer = null;
let reviewSaveChain = Promise.resolve();
let settingsSaveChain = Promise.resolve();
let settingsReady = Promise.resolve();
let pendingReviewEdits = new Map();
let reviewSaveError = "";
let linkingReviewPartId = "";
let historyJobsPromise = null;
let canliiDownloadDirectory = null;
let canliiCaptureGeneration = 0;
const canliiCaptures = new Map();
const savedOutputFiles = new Set();
let outputSavePending = false;
let outputSaveError = "";
let outputSaveFiles = "";
let settings = {
  setup_version: 0,
  offline: false,
  enrich_spans: true,
  prompt_for_scanned_pdfs: true,
  pdf_mode: "auto",
  tab_style: "numeric",
  output_mode: "book",
  table_delivery: "native_append",
  table_location: "pages",
  highlight_style: "margin",
  scanned_pdf_policy: "page_margin",
  court_profile: "general",
};

let courtProfiles = [];
let courtProfileById = new Map();

const settingFields = [
  ["court_profile", "Court preset", [["general", "General"]]],
  ["output_mode", "Create", [["book", "Book of Authorities (PDF)"], ["table", "Table of Authorities (Word)"], ["both", "Book and Table"]]],
  ["pdf_mode", "Source pages", [["auto", "Use originals; rebuild missing sources"], ["originals", "Use originals; add pages for missing sources"], ["render", "Rebuild all sources from text"]]],
  ["tab_style", "Tabs", [["numeric", "Numbers: 1, 2, 3"], ["alpha", "Letters: A, B, C"]]],
  ["highlight_style", "Passage marking", [["margin", "Margin + exact quote"], ["sidelined", "Black paragraph line"], ["paragraph", "Whole cited paragraph"], ["text", "Exact quote only"], ["none", "No marks"]]],
  ["scanned_pdf_policy", "If a source PDF has no searchable text", [["page_margin", "Keep the scan and mark cited pages"], ["cited_pages", "Make cited pages searchable"], ["full", "Make the whole PDF searchable"]]],
  ["table_delivery", "Put the table in", [["native_append", "A Word copy of the document"], ["linked_append", "A hyperlinked list at the end"], ["native_marks", "The original Word document"], ["pdf_append", "A PDF copy of the document"]]],
  ["table_location", "Show beside each source", [["pages", "Document pages"], ["pinpoints", "Authority pinpoints"], ["combined", "Pages and pinpoints"]]],
];

const checkboxFields = [
  ["offline", "Local only"],
  ["enrich_spans", "Resolve names"],
  ["prompt_for_scanned_pdfs", "Ask about scanned PDFs"],
];

function activeCourtProfile() {
  return courtProfileById.get(settings.court_profile) || courtProfileById.get("general") || null;
}

function applyCourtProfileConstraints() {
  const profile = activeCourtProfile();
  if (!profile) return;
  Object.entries(profile.allowed || {}).forEach(([key, values]) => {
    if (!values.includes(settings[key])) settings[key] = profile.defaults[key];
  });
  Object.assign(settings, profile.locked || {});
}

async function loadCourtProfiles() {
  const data = await api("court-profiles.json");
  if (!Array.isArray(data?.profiles) || !data.profiles.length) throw new Error("Court presets are unavailable.");
  courtProfiles = data.profiles;
  courtProfileById = new Map(courtProfiles.map((profile) => [profile.id, profile]));
  settingFields[0][2] = courtProfiles.map((profile) => [profile.id, profile.label]);
}

function renderCourtProfileNote() {
  const root = $("#court-profile-note");
  if (!root) return;
  const profile = activeCourtProfile();
  root.innerHTML = "";
  root.classList.toggle("hidden", !profile || profile.id === "general");
  if (!profile || profile.id === "general") return;

  const summary = document.createElement("p");
  summary.textContent = profile.summary;
  root.append(summary);
  if (profile.requirements?.length) {
    const list = document.createElement("ul");
    profile.requirements.forEach((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      list.append(item);
    });
    root.append(list);
  }
  if (profile.sources?.length) {
    const details = document.createElement("details");
    const heading = document.createElement("summary");
    heading.textContent = "Official sources";
    details.append(heading);
    const sources = document.createElement("div");
    sources.className = "court-profile-sources";
    profile.sources.forEach((source) => {
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title;
      const locator = document.createElement("small");
      locator.textContent = source.locator + (source.effective_from ? ` · effective ${source.effective_from}` : "");
      sources.append(link, locator);
    });
    details.append(sources);
    root.append(details);
  }
}

function apiPath(path) {
  if (
    !beaverMode
    || path === "/api/table-of-authorities/documents"
    || path.startsWith("/api/table-of-authorities/workspace/")
  ) return path;
  return path.startsWith("/api/")
    ? `/api/table-of-authorities/workspace${path.slice(4)}`
    : path;
}

async function request(path, options = {}) {
  return fetch(apiPath(path), options);
}

async function api(path, options = {}) {
  const response = await request(path, options);
  const type = response.headers.get("content-type") || "";
  const value = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(value?.error || value || `${response.status} ${response.statusText}`);
  return value;
}

function jobsPath(params = {}) {
  const search = new URLSearchParams(params);
  if (projectId) search.set("project", projectId);
  const value = search.toString();
  return `/api/jobs${value ? `?${value}` : ""}`;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove("show"), 3200);
}

function rememberJob(jobId) {
  const changed = currentJob !== jobId;
  currentJob = jobId;
  if (changed) {
    historyJobsPromise = null;
    canliiCaptureGeneration += 1;
    canliiCaptures.clear();
  }
  if (!sessionKey) return;
  try {
    if (jobId) sessionStorage.setItem(sessionKey, jobId);
    else sessionStorage.removeItem(sessionKey);
  } catch (error) { /* The current page still works without session storage. */ }
  const url = new URL(window.location.href);
  if (jobId) url.searchParams.set("job", jobId);
  else url.searchParams.delete("job");
  history.replaceState(null, "", url);
}

function switchView(name) {
  $$(".primary").forEach((button) => {
    const active = button.dataset.view === name;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === name));
  $(".primary-tabs").scrollTop = 0;
}

function syncWorkflowUi() {
  ["automatic", "manual"].forEach((mode) => {
    const active = activeWorkflow === mode;
    $(`#${mode}-start`).classList.toggle("hidden", active);
    $$(`[data-workflow-content="${mode}"]`).forEach((node) => node.classList.toggle("hidden", !active));
  });
}

function resumeWorkflow(mode) {
  activeWorkflow = mode;
  syncWorkflowUi();
  switchView(mode);
}

function placeJobUi(job) {
  const mode = activeWorkflow || (job?.operation === "manual book" ? "manual" : "automatic");
  $(`#${mode}-progress-slot`).append($("#job-status"));
  $(`#${mode}-output-slot`).append($("#output-card"));
}

function settingHeading(controlId, label) {
  const heading = document.createElement("div");
  heading.className = "setting-heading";
  const title = document.createElement("label");
  title.htmlFor = controlId;
  title.textContent = label;
  heading.append(title);
  return heading;
}

function renderSettingFields(target, prefix, fields) {
  const root = $(target);
  root.innerHTML = "";
  fields.forEach(([key, label, options]) => {
    const wrapper = document.createElement("div");
    wrapper.className = `setting-field${key === "output_mode" ? " primary-setting" : ""}`;
    wrapper.dataset.setting = key;
    if (key === "highlight_style") {
      const group = document.createElement("div");
      group.id = `${prefix}-${key}`;
      group.className = "mark-options";
      group.setAttribute("role", "radiogroup");
      group.setAttribute("aria-label", label);
      options.forEach(([value, text]) => {
        const choice = document.createElement("label");
        choice.className = "mark-option";
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `${prefix}-${key}`;
        input.value = value;
        input.checked = settings[key] === value;
        input.addEventListener("change", () => {
          if (!input.checked) return;
          settings[key] = value;
          syncSettings();
          saveSettings(false);
        });
        const preview = document.createElement("span");
        preview.className = `mark-preview ${value}`;
        preview.setAttribute("aria-hidden", "true");
        preview.innerHTML = "<i></i><i></i><i></i><b></b>";
        const name = document.createElement("strong");
        name.textContent = text;
        choice.append(input, preview, name);
        group.append(choice);
      });
      wrapper.append(settingHeading(group.id, label), group);
      root.append(wrapper);
      return;
    }
    const select = document.createElement("select");
    select.id = `${prefix}-${key}`;
    options.forEach(([value, text]) => select.add(new Option(text, value)));
    select.value = settings[key];
    const setTitle = () => {
      const text = select.selectedOptions[0]?.text || "";
      select.title = text;
      wrapper.dataset.valueLabel = text;
    };
    setTitle();
    select.addEventListener("change", () => {
      settings[key] = select.value;
      if (key === "court_profile") {
        Object.assign(settings, activeCourtProfile()?.defaults || {});
        applyCourtProfileConstraints();
      }
      setTitle();
      syncSettings();
      saveSettings(false);
    });
    wrapper.append(settingHeading(select.id, label), select);
    root.append(wrapper);
  });
}

function renderCheckboxFields() {
  const root = $("#all-settings");
  root.innerHTML = "";
  checkboxFields.forEach(([key, label]) => {
    const wrapper = document.createElement("div");
    wrapper.className = "check setting-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `all-${key}`;
    input.checked = settings[key];
    input.addEventListener("change", () => {
      settings[key] = input.checked;
      saveSettings(false);
    });
    wrapper.append(input, settingHeading(input.id, label));
    root.append(wrapper);
  });
}

function syncBuildFields() {
  const book = new Set(["pdf_mode", "tab_style", "highlight_style", "scanned_pdf_policy"]);
  const table = new Set(["table_delivery", "table_location"]);
  const running = currentJobState?.state === "running";
  const locked = activeCourtProfile()?.locked || {};
  $("#build-output_mode").disabled = running || Object.hasOwn(locked, "output_mode");
  $("#build-output_mode").closest(".setting-field").classList.toggle("court-fixed", Object.hasOwn(locked, "output_mode"));
  $("#build-court_profile").disabled = running;
  $$("#build-settings [data-setting]").forEach((field) => {
    const relevantForOutput = settings.output_mode === "both"
      || (settings.output_mode === "book" ? book : table).has(field.dataset.setting);
    const relevant = relevantForOutput
      && !(field.dataset.setting === "table_location" && settings.table_delivery === "linked_append");
    const fixed = Object.hasOwn(locked, field.dataset.setting);
    field.classList.toggle("inactive", !relevant);
    field.classList.toggle("court-fixed", fixed);
    field.querySelectorAll("select, input").forEach((control) => {
      control.disabled = running || !relevant || fixed;
    });
  });
}

function syncSettings() {
  applyCourtProfileConstraints();
  const allowed = activeCourtProfile()?.allowed || {};
  settingFields.forEach(([key]) => {
    $$(`#build-${key}`).forEach((node) => {
      if (node.tagName === "SELECT") {
        [...node.options].forEach((option) => {
          const permitted = !allowed[key] || allowed[key].includes(option.value);
          option.disabled = !permitted;
          option.hidden = !permitted;
        });
        node.value = settings[key];
        const text = node.selectedOptions[0]?.text || "";
        node.title = text;
        node.closest(".setting-field").dataset.valueLabel = text;
      }
    });
    $$(`input[name="build-${key}"]`).forEach((node) => {
      const permitted = !allowed[key] || allowed[key].includes(node.value);
      node.closest(".mark-option")?.classList.toggle("hidden", !permitted);
      node.checked = node.value === settings[key];
    });
  });
  ["offline", "enrich_spans", "prompt_for_scanned_pdfs"].forEach((key) => {
    const node = $(`#all-${key}`);
    if (node) node.checked = settings[key];
  });
  renderCourtProfileNote();
  syncBuildFields();
}

async function loadSettings() {
  try { settings = await api("/api/settings"); } catch (error) { toast(error.message); }
  syncSettings();
}

async function saveSettings(showToast = true) {
  const body = JSON.stringify(settings);
  const request = settingsSaveChain.then(() => api("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  }));
  settingsSaveChain = request.catch(() => {});
  try {
    settings = await request;
    syncSettings();
    if (showToast) toast("Saved.");
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

async function confirmScannedPdfPolicy() {
  if (!settings.prompt_for_scanned_pdfs || settings.highlight_style === "none" || settings.output_mode === "table") return true;
  const dialog = $("#scanned-pdf-dialog");
  const selected = dialog.querySelector(`input[name="scanned-policy"][value="${settings.scanned_pdf_policy}"]`)
    || dialog.querySelector('input[name="scanned-policy"]');
  selected.checked = true;
  $("#scanned-do-not-show").checked = false;
  dialog.showModal();
  const accepted = await new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "continue"), { once: true }));
  if (!accepted) return false;
  settings.scanned_pdf_policy = dialog.querySelector('input[name="scanned-policy"]:checked').value;
  settings.prompt_for_scanned_pdfs = !$("#scanned-do-not-show").checked;
  return true;
}

async function openSetup(workflow, force = false, start = true) {
  await settingsReady;
  if (!force && settings.setup_version >= SETUP_VERSION) {
    if (start) newSession(false, workflow);
    return;
  }
  const dialog = $("#setup-dialog");
  $("#setup-source-fieldset").classList.toggle("hidden", workflow !== "automatic");
  $("#setup-marking-fieldset").classList.toggle("hidden", workflow !== "automatic");
  $("#setup-manual-fieldset").classList.toggle("hidden", workflow !== "manual");
  const source = dialog.querySelector(`input[name="setup-pdf-mode"][value="${settings.pdf_mode}"]`)
    || dialog.querySelector('input[name="setup-pdf-mode"][value="auto"]');
  source.checked = true;
  const marking = dialog.querySelector(`input[name="setup-highlight-style"][value="${settings.highlight_style}"]`)
    || dialog.querySelector('input[name="setup-highlight-style"][value="margin"]');
  marking.checked = true;
  $("#setup-manual-title").value = manualState.book_title || "Book of Authorities";
  $("#setup-remember").checked = settings.setup_version >= SETUP_VERSION;
  $("#setup-submit").textContent = start ? "Start" : "Done";
  dialog.showModal();
  const accepted = await new Promise((resolve) => dialog.addEventListener(
    "close",
    () => resolve(dialog.returnValue === "continue"),
    { once: true },
  ));
  if (!accepted) return;
  if (workflow === "automatic") {
    settings.pdf_mode = dialog.querySelector('input[name="setup-pdf-mode"]:checked').value;
    settings.highlight_style = dialog.querySelector('input[name="setup-highlight-style"]:checked').value;
    applyCourtProfileConstraints();
  } else {
    manualState.book_title = $("#setup-manual-title").value.trim() || "Book of Authorities";
  }
  settings.setup_version = $("#setup-remember").checked ? SETUP_VERSION : 0;
  if (!(await saveSettings(false))) return;
  if (!start) {
    if (workflow === "manual") {
      renderManual();
      if (currentJob) {
        try { await saveManual(); } catch (error) { toast(error.message); }
      }
    }
    return;
  }
  const title = manualState.book_title;
  newSession(false, workflow);
  if (workflow === "manual") {
    manualState.book_title = title;
    renderManual();
  }
}

async function ensureJob() {
  if (currentJob) return currentJob;
  const job = await api(jobsPath(), { method: "POST", body: new Uint8Array() });
  rememberJob(job.id);
  updateJob(job);
  return currentJob;
}

async function uploadDocument(file) {
  if (!file) return;
  try {
    await flushReviewEdits();
    const job = await api(jobsPath({ filename: file.name }), {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    });
    rememberJob(job.id);
    currentReview = null;
    selectedReviewIndex = 0;
    updateJob(job);
    startPolling();
    await saveSourcePdf(file);
  } catch (error) { toast(error.message); }
  $("#document-input").value = "";
}

function renderBuildBlocker() {
  const node = $("#build-blocker");
  node.textContent = reviewSaveError;
  node.classList.toggle("hidden", !reviewSaveError);
}

function updateJob(job) {
  currentJobState = job;
  placeJobUi(job);
  const running = job?.state === "running";
  const files = job?.files || [];
  const hasReview = Boolean(job?.has_review);
  const hasManifest = Boolean(job?.has_manifest);
  const progress = job?.progress || 0;
  const inputName = job?.input_name || "";
  const failed = Boolean(job?.error);
  const message = running || failed ? job?.message || "" : "";
  $("#active-document").classList.toggle("hidden", !inputName);
  $("#import-row").classList.toggle("hidden", Boolean(inputName));
  $("#active-document-name").textContent = inputName;
  $("#active-document-name").title = inputName;
  $("#job-message").textContent = message;
  $("#job-message").title = message;
  $("#job-message").classList.toggle("status-error", failed);
  const progressNode = $("#job-progress");
  progressNode.value = progress;
  progressNode.classList.toggle("active", running);
  progressNode.setAttribute("aria-label", message ? `${message} (${progress}%)` : `Progress (${progress}%)`);
  $("#job-status").classList.toggle("hidden", !running && !failed);
  $("#job-status").setAttribute("aria-busy", running ? "true" : "false");
  $("#build-start").disabled = !hasReview || running || Boolean(reviewSaveError);
  $("#finalize-book").disabled = !hasManifest || running;
  $("#manual-build").disabled = !manualState.entries.length || running;
  renderBuildBlocker();
  if (!hasReview) $("#review-card").classList.add("hidden");
  if (!hasManifest) $("#insert-card").classList.add("hidden");
  if (hasManifest) $("#output-card").classList.add("hidden");
  else renderFiles(files);
  syncBuildFields();
}

async function pollJob() {
  if (!currentJob) return;
  try {
    const job = await api(`/api/jobs/${currentJob}`);
    if (job.state !== "running") {
      clearInterval(pollTimer);
      pollTimer = null;
      updateJob(job);
      if (job.has_review && !currentReview) await loadReview();
      if (job.has_manifest) await loadManifest();
    } else updateJob(job);
  } catch (error) {
    clearInterval(pollTimer);
    pollTimer = null;
    rememberJob("");
    updateJob(null);
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollJob();
  pollTimer = setInterval(pollJob, 900);
}

async function loadReview() {
  if (!currentJob) {
    $("#review-card").classList.add("hidden");
    return;
  }
  try {
    currentReview = await api(`/api/jobs/${currentJob}/review`);
    pendingReviewEdits.clear();
    reviewSaveError = "";
    renderBuildBlocker();
    renderReview();
  } catch (error) {
    $("#review-card").classList.add("hidden");
    $("#review-body").innerHTML = "";
  }
}

function renderReview() {
  $("#review-card").classList.remove("hidden");
  $("#review-summary").textContent = `${currentReview.parts.length} citation${currentReview.parts.length === 1 ? "" : "s"}`;
  selectedReviewIndex = Math.min(selectedReviewIndex, Math.max(0, currentReview.parts.length - 1));
  renderReviewList();
  renderReviewEditor();
}

function renderReviewList() {
  const root = $("#review-list");
  root.innerHTML = "";
  currentReview.parts.forEach((part, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "citation-item";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selectedReviewIndex));
    button.innerHTML = `
      <span class="citation-location">${escapeHtml(reviewLocation(part, index))}</span>
      <strong class="citation-name">${escapeHtml(reviewCitation(part))}</strong>`;
    button.addEventListener("click", async () => {
      if (linkingReviewPartId) {
        const reference = currentReview.parts.find(
          (candidate) => reviewPartId(candidate) === linkingReviewPartId,
        );
        let target = part;
        if (target.kind === "reference" && target.supra_target) {
          target = currentReview.parts.find(
            (candidate) => reviewPartId(candidate) === target.supra_target,
          );
        }
        if (!reference || !target || target.kind === "reference" || reference === target) {
          return toast("Choose a full authority.");
        }
        reference.supra_target = reviewPartId(target);
        queueReviewEdit(reference, { supra_target: reference.supra_target });
        try {
          await flushReviewEdits();
          linkingReviewPartId = "";
          selectedReviewIndex = currentReview.parts.indexOf(reference);
          renderReview();
        } catch (error) {
          toast(error.message);
        }
        return;
      }
      void flushReviewEdits().catch(() => {});
      root.children[selectedReviewIndex]?.setAttribute("aria-selected", "false");
      selectedReviewIndex = index;
      button.setAttribute("aria-selected", "true");
      renderReviewEditor();
    });
    root.append(button);
  });
}

function selectedReviewUnit(part) {
  const unit = (currentReview.units || []).find((candidate) => candidate.key === part.unit_key);
  if (unit) return { ...unit, synthetic: false };
  return {
    key: part.unit_key,
    kind: (part.unit_key || "").startsWith("footnote:") ? "footnote" : "body",
    text: part.text || "",
    synthetic: true,
  };
}

function reviewRange(part, unit, startName, endName, fallbackStart, fallbackEnd) {
  if (unit.synthetic) {
    const offset = Number.isInteger(part.start) ? part.start : 0;
    const start = Number.isInteger(part[startName]) ? part[startName] - offset : fallbackStart;
    const end = Number.isInteger(part[endName]) ? part[endName] - offset : fallbackEnd;
    return [Math.max(0, start), Math.min(unit.text.length, end)];
  }
  return [
    Number.isInteger(part[startName]) ? part[startName] : fallbackStart,
    Number.isInteger(part[endName]) ? part[endName] : fallbackEnd,
  ];
}

function reviewPinpointRange(part, unit, authorityEnd) {
  const explicit = reviewRange(part, unit, "pinpoint_start", "pinpoint_end", -1, -1);
  if (explicit[0] >= 0 && explicit[0] < explicit[1]) return explicit;
  const needle = (part.pinpoint_fragments || [])[0] || "";
  if (!needle) return [-1, -1];
  const index = unit.text.toLowerCase().indexOf(needle.toLowerCase(), Math.max(0, authorityEnd));
  return index < 0 ? [-1, -1] : [index, index + needle.length];
}

function humanPinpoint(value) {
  return String(value || "")
    .replace(/^par(?=\d)/i, "para ")
    .replace(/^pp(?=\d)/i, "pp ")
    .replace(/^ss(?=\d)/i, "ss ")
    .replace(/^s(?=\d)/i, "s ");
}

function reviewSurfaceMarkup(unit, part) {
  const partRange = reviewRange(part, unit, "start", "end", 0, unit.text.length);
  const authorityRange = reviewRange(
    part,
    unit,
    "authority_start",
    "authority_end",
    partRange[0],
    partRange[1],
  );
  const pinpointRange = reviewPinpointRange(part, unit, authorityRange[1]);
  const ranges = [
    [...authorityRange, "authority"],
    [...pinpointRange, "pinpoint"],
  ].filter(([start, end]) => start >= 0 && start < end && start < unit.text.length);
  const boundaries = new Set([0, unit.text.length]);
  ranges.forEach(([start, end]) => {
    boundaries.add(Math.max(0, start));
    boundaries.add(Math.min(unit.text.length, end));
  });
  const points = [...boundaries].sort((left, right) => left - right);
  return points.slice(0, -1).map((start, index) => {
    const end = points[index + 1];
    const classes = ranges
      .filter(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd)
      .map(([, , name]) => `review-${name}`)
      .join(" ");
    const text = escapeHtml(unit.text.slice(start, end));
    return classes ? `<span class="${classes}">${text}</span>` : text;
  }).join("");
}

function reviewSelection(surface) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(surface);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  const end = prefix.toString().length;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

async function applyReviewAction(action, values = {}) {
  const part = currentReview.parts[selectedReviewIndex];
  if (!part) return;
  try {
    await flushReviewEdits();
    const result = await api(`/api/jobs/${currentJob}/review/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, part_id: reviewPartId(part), ...values }),
    });
    currentReview = result.review;
    pendingReviewEdits.clear();
    linkingReviewPartId = "";
    selectedReviewIndex = Math.max(
      0,
      currentReview.parts.findIndex(
        (candidate) => reviewPartId(candidate) === result.selected_part_id,
      ),
    );
    renderReview();
  } catch (error) {
    toast(error.message);
  }
}

function renderReviewEditor() {
  const body = $("#review-body");
  const part = currentReview.parts[selectedReviewIndex];
  if (!part) {
    body.innerHTML = '<p class="muted">No citations found.</p>';
    return;
  }
  const unit = selectedReviewUnit(part);
  const siblings = currentReview.parts
    .filter((candidate) => candidate.unit_key === part.unit_key)
    .sort((left, right) => (left.start || 0) - (right.start || 0));
  const pinpoint = (part.pinpoint_fragments || []).map(humanPinpoint).join(", ")
    || ((part.page_pinpoints || []).length ? `pp ${(part.page_pinpoints || []).join(", ")}` : "No pinpoint");
  const kind = {
    case: "Case",
    statute: "Legislation",
    journal: "Journal article",
    reference: "Cross-reference",
    other: "Other source",
  }[part.kind] || "Other source";
  const target = currentReview.parts.find(
    (candidate) => reviewPartId(candidate) === part.supra_target,
  );
  body.innerHTML = `
    <div class="review-meta">${escapeHtml(kind)} <span aria-hidden="true">·</span> ${escapeHtml(pinpoint)}</div>
    <div id="review-surface" class="review-surface" contenteditable="true" role="textbox"
      aria-readonly="true" aria-label="${escapeAttr(reviewLocation(part, selectedReviewIndex))} full citation text"
      spellcheck="false">${reviewSurfaceMarkup(unit, part)}</div>
    <div class="review-actions">
      <button type="button" id="mark-authority">Use selection as authority</button>
      <button type="button" id="mark-pinpoint" class="secondary">Use selection as pinpoint</button>
      <button type="button" id="split-citation" class="secondary"${unit.kind === "footnote" ? "" : " disabled"}>Split at cursor</button>
      <button type="button" id="merge-citation" class="secondary"${unit.kind === "footnote" && siblings[0] !== part ? "" : " disabled"}>Merge with previous</button>
    </div>
    ${part.kind === "reference" ? `
      <div class="review-link">
        <span>${target ? `Linked to ${escapeHtml(reviewCitation(target))}` : "No linked authority"}</span>
        <button type="button" id="link-citation" class="secondary">Link to authority</button>
        <button type="button" id="clear-link" class="secondary"${part.supra_target ? "" : " disabled"}>Clear link</button>
      </div>` : `
      <div class="review-link review-link-placeholder" aria-hidden="true">
        <span>No linked authority</span>
        <button type="button" tabindex="-1" class="secondary">Link to authority</button>
        <button type="button" tabindex="-1" class="secondary">Clear link</button>
      </div>`}`;

  const surface = $("#review-surface");
  surface.addEventListener("beforeinput", (event) => event.preventDefault());
  surface.addEventListener("paste", (event) => event.preventDefault());
  surface.addEventListener("drop", (event) => event.preventDefault());
  surface.addEventListener("keydown", (event) => {
    if (!event.ctrlKey && !event.metaKey && event.key.length === 1) event.preventDefault();
    if (["Backspace", "Delete", "Enter"].includes(event.key)) event.preventDefault();
  });
  $("#mark-authority").addEventListener("click", () => {
    const range = reviewSelection(surface);
    if (!range || range.start === range.end) return toast("Select the authority text first.");
    void applyReviewAction("authority", range);
  });
  $("#mark-pinpoint").addEventListener("click", () => {
    const range = reviewSelection(surface);
    if (!range || range.start === range.end) return toast("Select the pinpoint text first.");
    void applyReviewAction("pinpoint", range);
  });
  $("#split-citation").addEventListener("click", () => {
    const range = reviewSelection(surface);
    if (!range || range.start !== range.end) return toast("Place the cursor at the split point.");
    void applyReviewAction("split", { cursor: range.start });
  });
  $("#merge-citation").addEventListener("click", () => void applyReviewAction("merge"));
  $("#link-citation")?.addEventListener("click", () => {
    linkingReviewPartId = reviewPartId(part);
    toast("Now choose the full authority in the citation list.");
  });
  $("#clear-link")?.addEventListener("click", async () => {
    part.supra_target = "";
    queueReviewEdit(part, { supra_target: "" });
    try {
      await flushReviewEdits();
      renderReviewEditor();
    } catch (error) {
      toast(error.message);
    }
  });
}

function reviewPartId(part) {
  return part.uid || `${part.unit_key}:${part.index}`;
}

function reviewLocation(part, index) {
  if (Number.isInteger(part.note_number)) return `Footnote ${part.note_number}`;
  const body = /^body:(\d+)$/.exec(part.unit_key || "");
  return body ? `Document paragraph ${Number(body[1]) + 1}` : `Citation ${index + 1}`;
}

function reviewCitation(part) {
  const value = part.resolved_name || part.citation || part.bare_citation || "Untitled source";
  return value.length > 90 ? `${value.slice(0, 89)}…` : value;
}

function queueReviewEdit(part, changes) {
  const partId = reviewPartId(part);
  pendingReviewEdits.set(partId, {
    ...(pendingReviewEdits.get(partId) || {}),
    ...changes,
  });
  reviewSaveError = "";
  renderBuildBlocker();
  clearTimeout(reviewSaveTimer);
  reviewSaveTimer = setTimeout(
    () => void flushReviewEdits().catch(() => {}),
    350,
  );
}

async function flushReviewEdits() {
  clearTimeout(reviewSaveTimer);
  reviewSaveTimer = null;
  if (!pendingReviewEdits.size || !currentJob) return reviewSaveChain;
  const jobId = currentJob;
  const edits = [...pendingReviewEdits].map(([part_id, changes]) => ({
    part_id,
    changes,
  }));
  pendingReviewEdits.clear();
  const request = reviewSaveChain.catch(() => {}).then(() =>
    api(`/api/jobs/${jobId}/review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
    }),
  );
  reviewSaveChain = request;
  try {
    await request;
    reviewSaveError = "";
  } catch (error) {
    edits.forEach(({ part_id, changes }) => {
      pendingReviewEdits.set(part_id, {
        ...changes,
        ...(pendingReviewEdits.get(part_id) || {}),
      });
    });
    reviewSaveError = "Citation edits could not be saved. Try again before building.";
    throw error;
  } finally {
    renderBuildBlocker();
    $("#build-start").disabled =
      !currentJobState?.has_review ||
      currentJobState?.state === "running" ||
      Boolean(reviewSaveError);
  }
}

async function buildAutomatic() {
  if (!currentJob) return toast("Choose a document first.");
  try {
    await flushReviewEdits();
    if (!(await confirmScannedPdfPolicy())) return;
    if (!(await saveSettings(false))) return;
    const job = await api(`/api/jobs/${currentJob}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    $("#insert-card").classList.add("hidden");
    renderFiles([]);
    updateJob(job);
    startPolling();
  } catch (error) { toast(error.message); }
}

function renderFiles(files) {
  const card = $("#output-card");
  const root = $("#output-files");
  const signature = files.map(outputFileKey).join("\0");
  if (signature !== outputSaveFiles) outputSaveError = "";
  outputSaveFiles = signature;
  if (!files.length) {
    root.innerHTML = "";
    card.classList.add("hidden");
    return;
  }
  root.innerHTML = "";
  files.forEach((file) => {
    const row = document.createElement("div");
    row.className = "file-item";
    row.innerHTML = `<div><strong class="file-name" title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong><small class="muted">${formatBytes(file.size)}</small></div><button type="button" class="download-link" aria-label="Download ${escapeAttr(file.name)}" title="Download"><span aria-hidden="true">↓</span></button>`;
    row.querySelector(".download-link").addEventListener("click", async () => {
      try {
        const response = await request(file.url);
        if (!response.ok) throw new Error(`Download failed (${response.status}).`);
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        URL.revokeObjectURL(url);
      } catch (error) { toast(error.message); }
    });
    root.append(row);
  });
  if (beaverMode) {
    const keys = files.map(outputFileKey);
    const saved = keys.every((key) => savedOutputFiles.has(key));
    const actions = document.createElement("div");
    actions.className = "output-save";
    actions.innerHTML = `<span class="${outputSaveError ? "status-error" : "muted"}" role="status">${escapeHtml(outputSaveError)}</span><button type="button" class="secondary"${saved || outputSavePending ? " disabled" : ""}>${saved ? "Saved" : outputSavePending ? "Saving..." : "Save"}</button>`;
    actions.querySelector("button").addEventListener("click", () => saveGeneratedFiles(files));
    root.append(actions);
  }
  card.classList.remove("hidden");
}

function outputFileKey(file) {
  return `${file.url}\n${file.name}\n${file.size}`;
}

async function saveAuthoritiesFile(file, name = file.name) {
  if (!beaverMode) return;
  const form = new FormData();
  form.append("file", file, name);
  await api("/api/table-of-authorities/documents", { method: "POST", body: form });
}

async function saveSourcePdf(file) {
  if (file && (file.type === "application/pdf" || /\.pdf$/iu.test(file.name))) {
    await saveAuthoritiesFile(file);
  }
}

async function saveGeneratedFiles(files) {
  if (outputSavePending) return;
  outputSavePending = true;
  outputSaveError = "";
  renderFiles(files);
  try {
    for (const file of files) {
      const key = outputFileKey(file);
      if (savedOutputFiles.has(key)) continue;
      const response = await request(file.url);
      if (!response.ok) throw new Error(`Save failed (${response.status}).`);
      await saveAuthoritiesFile(await response.blob(), file.name);
      savedOutputFiles.add(key);
    }
  } catch (error) {
    outputSaveError = error.message || "Could not save output.";
  } finally {
    outputSavePending = false;
    renderFiles(files);
  }
}

function canliiPdfFilename(url) {
  try {
    const name = new URL(url).pathname.split("/").pop() || "";
    return decodeURIComponent(name).replace(/[^A-Za-z0-9._-]/g, "");
  } catch (error) {
    return "";
  }
}

function matchesCanliiDownload(name, expected) {
  const dot = expected.toLowerCase().lastIndexOf(".pdf");
  if (dot < 1) return false;
  const stem = expected.slice(0, dot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${stem}(?: \\(\\d+\\))?\\.pdf$`, "iu").test(name);
}

async function newestCanliiDownload(expected) {
  if (!canliiDownloadDirectory) return null;
  let newest = null;
  for await (const handle of canliiDownloadDirectory.values()) {
    if (handle.kind !== "file" || !matchesCanliiDownload(handle.name, expected)) continue;
    const file = await handle.getFile();
    if (!newest || file.lastModified > newest.lastModified) newest = file;
  }
  return newest;
}

async function enableCanliiCapture() {
  if (!("showDirectoryPicker" in window)) return;
  try {
    const directory = await window.showDirectoryPicker({ id: "canlii-downloads", mode: "read" });
    const permission = await directory.requestPermission({ mode: "read" });
    if (permission !== "granted") return;
    canliiDownloadDirectory = directory;
    const button = $("#canlii-capture-enable");
    button.textContent = "Watching download folder";
    button.setAttribute("aria-pressed", "true");
    toast("Saved CanLII PDFs will attach from that folder.");
  } catch (error) {
    if (error?.name !== "AbortError") toast(error.message || "Could not open the download folder.");
  }
}

async function captureCanliiDownload(row) {
  if (!canliiDownloadDirectory) return;
  const expected = canliiPdfFilename(row.manual_pdf_url);
  if (!expected) return;
  const token = {};
  canliiCaptures.set(row.key, token);
  const generation = canliiCaptureGeneration;
  const jobId = currentJob;
  const started = Date.now();
  const before = await newestCanliiDownload(expected);
  const beforeKey = before ? `${before.lastModified}:${before.size}` : "";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (generation !== canliiCaptureGeneration || currentJob !== jobId || canliiCaptures.get(row.key) !== token) return;
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const file = await newestCanliiDownload(expected);
    if (!file || file.lastModified < started - 2000 || `${file.lastModified}:${file.size}` === beforeKey) continue;
    const header = new TextDecoder("ascii").decode(await file.slice(0, 5).arrayBuffer());
    if (header !== "%PDF-") continue;
    if (await attachPdf(row.key, file)) toast(`${file.name} attached.`);
    if (canliiCaptures.get(row.key) === token) canliiCaptures.delete(row.key);
    return;
  }
  if (canliiCaptures.get(row.key) === token) canliiCaptures.delete(row.key);
  toast("Download not found. Use Add downloaded PDF to attach it.");
}

function syncCanliiCaptureControl(rows) {
  const linked = rows.filter((row) => row.manual_pdf_url);
  const button = $("#canlii-capture-enable");
  const note = $("#canlii-handoff-note");
  const available = linked.length > 0 && "showDirectoryPicker" in window;
  button.classList.toggle("hidden", !available);
  note.classList.toggle("hidden", linked.length === 0);
  note.textContent = available
    ? "CanLII opens separately. Save the PDF, then add it here or watch a folder to attach it automatically."
    : "CanLII opens separately. Save the PDF, then add it here.";
  if (!canliiDownloadDirectory) {
    button.textContent = "Watch download folder";
    button.setAttribute("aria-pressed", "false");
  }
}

async function loadManifest() {
  const root = $("#authority-list");
  if (!currentJob) {
    $("#insert-card").classList.add("hidden");
    syncCanliiCaptureControl([]);
    return;
  }
  try {
    const manifest = await api(`/api/jobs/${currentJob}/manifest`);
    $("#insert-card").classList.toggle("hidden", !manifest.can_finalize);
    $("#finalize-book").disabled = !manifest.can_finalize || currentJobState?.state === "running";
    root.innerHTML = "";
    if (!manifest.can_finalize) {
      syncCanliiCaptureControl([]);
      renderFiles(currentJobState?.files || []);
      return;
    }
    $("#manifest-summary").textContent = manifest.placeholder_count
      ? `${manifest.placeholder_count} source PDF${manifest.placeholder_count === 1 ? "" : "s"} missing`
      : "All source PDFs found";
    const missing = manifest.authorities.filter((row) => row.needs_pdf);
    syncCanliiCaptureControl(missing);
    missing.forEach((row) => {
      const node = document.createElement("div");
      node.className = "authority";
      const info = document.createElement("div");
      const name = (row.name || "").trim();
      const citation = (row.citation || "").trim();
      const displayLabel = name || citation || row.tab || "Authority";
      info.innerHTML = `<strong>${escapeHtml(displayLabel)}</strong>${citation && citation !== displayLabel ? `<small class="muted">${escapeHtml(citation)}</small>` : ""}`;
      const actions = document.createElement("div");
      actions.className = "authority-actions";
      if (row.manual_pdf_url) {
        const download = document.createElement("a");
        download.className = "secondary";
        download.href = row.manual_pdf_url;
        download.target = "_blank";
        download.rel = "noopener noreferrer";
        download.textContent = "Open CanLII PDF";
        download.setAttribute("aria-describedby", "canlii-handoff-note");
        download.addEventListener("click", () => void captureCanliiDownload(row));
        actions.append(download);
      }
      const label = document.createElement("label");
      label.className = "secondary";
      label.innerHTML = `<button type="button">${row.manual_pdf_url ? "Add downloaded PDF" : "Choose PDF"}</button><input type="file" accept=".pdf,application/pdf" hidden>`;
      const input = label.querySelector("input");
      label.querySelector("button").addEventListener("click", () => input.click());
      input.addEventListener("change", (event) => attachPdf(row.key, event.target.files[0]));
      actions.append(label);
      node.append(info, actions);
      root.append(node);
    });
    renderFiles(currentJobState?.files || []);
  } catch (error) {
    $("#insert-card").classList.add("hidden");
    syncCanliiCaptureControl([]);
    root.innerHTML = "";
    renderFiles(currentJobState?.files || []);
  }
}

async function attachPdf(key, file) {
  if (!file) return false;
  try {
    const job = await api(`/api/jobs/${currentJob}/attach?key=${encodeURIComponent(key)}&filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/pdf" },
      body: file,
    });
    updateJob(job);
    startPolling();
    await saveSourcePdf(file);
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

async function finalizeBook() {
  if (!currentJob) return;
  try {
    const job = await api(`/api/jobs/${currentJob}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ omit_placeholders: $("#omit-placeholders").checked }),
    });
    updateJob(job);
    startPolling();
  } catch (error) { toast(error.message); }
}

async function loadManual() {
  if (!currentJob) return renderManual();
  try {
    manualState = await api(`/api/jobs/${currentJob}/manual`);
    renderManual();
  } catch (error) { toast(error.message); }
}

function renderManual() {
  $("#manual-title").value = manualState.book_title;
  const count = manualState.entries.length;
  $("#manual-count").textContent = `${count} PDF${count === 1 ? "" : "s"}`;
  $("#manual-build").disabled = !count || currentJobState?.state === "running";
  $("#manual-list-header").classList.toggle("hidden", !count);
  const root = $("#manual-list");
  if (!count) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = "";
  manualState.entries.forEach((row, index) => {
    const node = document.createElement("div");
    node.className = "manual-row";
    node.innerHTML = `
      <div class="move">
        <button type="button" class="secondary" data-move="-1" aria-label="Move ${escapeAttr(row.filename)} up"${index ? "" : " disabled"}>↑</button>
        <button type="button" class="secondary" data-move="1" aria-label="Move ${escapeAttr(row.filename)} down"${index < count - 1 ? "" : " disabled"}>↓</button>
      </div>
      <input type="text" data-field="tab" aria-label="Tab" value="${escapeAttr(row.tab)}">
      <input type="text" data-field="title" aria-label="Displayed title" value="${escapeAttr(row.title)}">
      <span class="manual-filename" title="${escapeAttr(row.filename)}">${escapeHtml(row.filename)}</span>
      <button type="button" class="remove" aria-label="Remove ${escapeAttr(row.filename)}">Remove</button>`;
    node.querySelectorAll("[data-field]").forEach((input) => input.addEventListener("change", async () => {
      row[input.dataset.field] = input.value;
      try { await saveManual(); } catch (error) { toast(error.message); }
    }));
    node.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => {
      const target = index + Number(button.dataset.move);
      if (target < 0 || target >= manualState.entries.length) return;
      [manualState.entries[index], manualState.entries[target]] = [manualState.entries[target], manualState.entries[index]];
      renderManual();
      saveManual().catch((error) => toast(error.message));
    }));
    node.querySelector(".remove").addEventListener("click", () => {
      if (window.confirm(`Remove ${row.filename} from this book?`)) removeManual(row.id);
    });
    root.append(node);
  });
}

async function saveManual() {
  await ensureJob();
  manualState.book_title = $("#manual-title").value.trim() || "Book of Authorities";
  manualState = await api(`/api/jobs/${currentJob}/manual`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manualState),
  });
  renderManual();
}

async function uploadManual(files) {
  if (!files.length) return;
  try {
    const title = $("#manual-title").value.trim() || "Book of Authorities";
    if (currentJob && manualState.entries.length) await saveManual();
    await ensureJob();
    for (const file of files) {
      manualState = await api(`/api/jobs/${currentJob}/manual/files?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/pdf" },
        body: file,
      });
      manualState.book_title = title;
      renderManual();
      await saveSourcePdf(file);
    }
    await saveManual();
  } catch (error) { toast(error.message); }
  $("#manual-files").value = "";
}

async function removeManual(id) {
  try {
    await api(`/api/jobs/${currentJob}/manual/files/${id}`, { method: "DELETE" });
    manualState.entries = manualState.entries.filter((row) => row.id !== id);
    renderManual();
  } catch (error) { toast(error.message); }
}

async function buildManual() {
  try {
    await saveManual();
    const job = await api(`/api/jobs/${currentJob}/manual/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manualState),
    });
    updateJob(job);
    startPolling();
  } catch (error) { toast(error.message); }
}

function historyLabel(job) {
  return job.input_name || "Manual PDF session";
}

function historyDate(job) {
  const value = job.updated_at || job.created_at;
  const date = value && new Date(value);
  return date && !Number.isNaN(date.valueOf())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
    : "";
}

async function openHistoryJob(job) {
  await flushReviewEdits();
  clearInterval(pollTimer);
  pollTimer = null;
  currentReview = null;
  selectedReviewIndex = 0;
  rememberJob(job.id);
  resumeWorkflow(job.operation === "manual book" ? "manual" : "automatic");
  updateJob(job);
  if (job.operation === "manual book") await loadManual();
  if (job.has_review) await loadReview();
  if (job.has_manifest && job.state !== "running") await loadManifest();
  if (job.state === "running") startPolling();
}

function preloadHistory() {
  if (!historyJobsPromise) {
    historyJobsPromise = api(jobsPath())
      .then(({ jobs }) => jobs)
      .catch((error) => {
        historyJobsPromise = null;
        throw error;
      });
  }
  return historyJobsPromise;
}

async function loadHistory() {
  const root = $("#history-list");
  try {
    const jobs = await preloadHistory();
    root.innerHTML = "";
    if (!jobs.length) {
      root.innerHTML = '<p class="muted">No saved sessions.</p>';
      return;
    }
    jobs.forEach((job) => {
      const button = document.createElement("button");
      const date = historyDate(job);
      button.type = "button";
      button.className = "history-item";
      button.innerHTML = `<strong title="${escapeAttr(historyLabel(job))}">${escapeHtml(historyLabel(job))}</strong><time>${escapeHtml(date)}</time>`;
      button.addEventListener("click", () => openHistoryJob(job).catch((error) => toast(error.message)));
      root.append(button);
    });
  } catch (error) {
    root.innerHTML = `<p class="status-error">History unavailable: ${escapeHtml(error.message)}</p>`;
  }
}

function newSession(showToast = true, workflow = "") {
  clearInterval(pollTimer);
  pollTimer = null;
  rememberJob("");
  currentReview = null;
  clearTimeout(reviewSaveTimer);
  reviewSaveTimer = null;
  pendingReviewEdits.clear();
  reviewSaveError = "";
  selectedReviewIndex = 0;
  currentJobState = null;
  manualState = { book_title: "Book of Authorities", entries: [] };
  $("#review-summary").textContent = "";
  $("#review-list").innerHTML = "";
  $("#review-body").innerHTML = "";
  $("#review-card").classList.add("hidden");
  $("#insert-card").classList.add("hidden");
  $("#manifest-summary").textContent = "";
  $("#authority-list").innerHTML = "";
  renderFiles([]);
  renderManual();
  activeWorkflow = workflow;
  updateJob(null);
  syncWorkflowUi();
  switchView(workflow || "automatic");
  if (showToast) toast("New session.");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }
function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

$$(".primary").forEach((button) => button.addEventListener("click", async () => {
  const view = button.dataset.view;
  if (view === "history") await loadHistory();
  if (view === "settings") await settingsReady;
  switchView(view);
  if (view === "manual" && activeWorkflow === "manual") loadManual();
}));
$(".primary-tabs").addEventListener("focusin", (event) => { event.currentTarget.scrollTop = 0; });
$("#automatic-create").addEventListener("click", () => openSetup("automatic"));
$("#manual-create").addEventListener("click", () => openSetup("manual"));
$("#document-input").addEventListener("change", (event) => uploadDocument(event.target.files[0]));
$("#replace-document").addEventListener("click", () => $("#document-input").click());
$("#build-start").addEventListener("click", buildAutomatic);
$("#finalize-book").addEventListener("click", finalizeBook);
$("#canlii-capture-enable").addEventListener("click", enableCanliiCapture);
$("#manual-files").addEventListener("change", (event) => uploadManual([...event.target.files]));
$("#manual-build").addEventListener("click", buildManual);
$("#manual-title").addEventListener("change", () => {
  manualState.book_title = $("#manual-title").value.trim() || "Book of Authorities";
  if (manualState.entries.length) saveManual().catch((error) => toast(error.message));
});
$("#setup-open").addEventListener("click", () => openSetup(activeWorkflow || "automatic", true, false));
$("#session-new").addEventListener("click", async () => {
  try {
    await flushReviewEdits();
    newSession();
  } catch (error) {
    toast("Citation edits could not be saved.");
  }
});

async function boot() {
  await loadCourtProfiles();
  renderSettingFields("#output-setting", "build", settingFields.slice(0, 2));
  renderSettingFields("#build-settings", "build", settingFields.slice(2));
  renderCheckboxFields();
  syncBuildFields();
  syncWorkflowUi();
  updateJob(null);
  void preloadHistory().catch(() => {});
  settingsReady = loadSettings();
  if (currentJob) {
    await settingsReady;
    try {
      const job = await api(`/api/jobs/${currentJob}`);
      resumeWorkflow(job.operation === "manual book" ? "manual" : "automatic");
      rememberJob(job.id);
      updateJob(job);
      if (job.state === "running") startPolling();
      if (job.has_review) await loadReview();
      if (job.has_manifest && job.state !== "running") await loadManifest();
      if (job.operation === "manual book") await loadManual();
    } catch (error) {
      newSession(false);
    }
  }
}

let bootComplete = false;
let parentOrigin = "";
let bootPromise = null;

function signalReady() {
  if (!bootComplete || !parentOrigin) return;
  window.parent.postMessage({
    type: "mike:authorities-helper-ready",
    attempt: readyAttempt,
  }, parentOrigin);
}

function signalError(error) {
  if (!parentOrigin) return;
  window.parent.postMessage({
    type: "mike:authorities-helper-error",
    attempt: readyAttempt,
    message: error?.message || "AuthoritiesHelper could not be started.",
  }, parentOrigin);
}

window.addEventListener("message", (event) => {
  if (
    event.source === window.parent
    && event.origin === window.location.origin
    && event.data?.type === "mike:authorities-helper-probe"
  ) {
    parentOrigin = event.origin;
    startBoot();
  }
});

function startBoot() {
  bootPromise ||= boot().then(
    () => {
      bootComplete = true;
      signalReady();
    },
    signalError,
  );
  signalReady();
}

if (!beaverMode) startBoot();
