// The verifier's settings as the page shows them: the desktop app's settings (ALR-Quote-Verifier
// gui.py DEFAULT_GUI_SETTINGS and its Settings tab), each choice with one plain sentence.
// The run reads the same keys (backend/src/lib/alrVerifier/settings.ts).
import { DEFAULT_ALR_SETTINGS } from "../../../backend/src/lib/alrVerifier/settings";

export const RUN_MODES = [
  { value: "high_accuracy", label: "High accuracy", detail: "Uses AI to read every footnote." },
  { value: "economy", label: "Economy", detail: "Handles straightforward supra and ibid footnotes without AI and uses AI for the rest." },
  { value: "ultra_economy", label: "Ultra economy", detail: "Also handles clearly structured citations without AI, and uses AI whenever anything important is uncertain." },
  { value: "free", label: "Free (no AI calls)", detail: "Makes no AI calls. Footnotes it cannot split with confidence are kept together for review." },
];
export const SUPRA_LINKING = [
  { value: "safe", label: "Safe", detail: "Links only the ibid and supra references it can identify with high confidence." },
  { value: "aggressive", label: "Aggressive", detail: "Also uses a cited note number when that note holds one source, and predictable short names of earlier sources. Conflicting matches are rejected." },
];
export const PARALLEL_FILES = [
  { value: "auto", label: "Auto (recommended)" },
  { value: "1", label: "1 — one at a time" },
  { value: "2", label: "2 at once" },
  { value: "3", label: "3 at once" },
  { value: "4", label: "4 at once" },
];
export const EXPORT_DETAIL = [
  { value: "display", label: "Display rows only", detail: "Writes the review columns and leaves the diagnostic columns out." },
  { value: "display-json", label: "Display + JSON", detail: "Writes the review columns, and the diagnostic columns to a JSON file beside the workbook." },
  { value: "diagnostic-hidden", label: "Display + hidden diagnostics", detail: "Writes the diagnostic columns as hidden columns you can unhide in Excel." },
  { value: "diagnostic", label: "Everything (diagnostic rows)", detail: "Writes every diagnostic column, visible." },
];
export const FRAG_MODES = [
  { value: "all", label: "All links", detail: "Adds a #:~:text= fragment to suggested links so the cited passage is highlighted when the link opens." },
  { value: "pinpointless", label: "Links without a pinpoint", detail: "Adds the fragment only to citations without a paragraph pinpoint." },
  { value: "off", label: "Off", detail: "Adds no fragments." },
];
export const PROPOSITION_MODES = [
  { value: "footnote_sentence", label: "Footnote sentence", detail: "Puts the one sentence around the footnote marker in the quote and proposition column." },
  { value: "passage_since_prior_note", label: "Passage since prior note", detail: "Puts all body text since the previous footnote marker in the quote and proposition column." },
];

// The verifier's own defaults (the desktop app's), except the mode: the page carries no AI key, so it
// starts in Free mode, which needs nothing. The choices below keep "Articles at once" as text.
export const DEFAULT_SETTINGS = { ...DEFAULT_ALR_SETTINGS, run_mode: "free", parallel_files: String(DEFAULT_ALR_SETTINGS.parallel_files) };

const CHOICES = { run_mode: RUN_MODES, supra_linking: SUPRA_LINKING, parallel_files: PARALLEL_FILES,
  export_detail: EXPORT_DETAIL, frag_mode: FRAG_MODES, proposition_mode: PROPOSITION_MODES };

/** Saved settings over the defaults; an unknown or invalid value takes its default. */
export function withDefaults(saved) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = saved?.[key];
    if (value === undefined) continue;
    if (CHOICES[key] ? CHOICES[key].some((choice) => choice.value === String(value))
      : typeof value === typeof DEFAULT_SETTINGS[key]) settings[key] = CHOICES[key] ? String(value) : value;
  }
  return settings;
}
