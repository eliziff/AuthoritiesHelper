// Settings › AI provider: connect OpenRouter in one click (OAuth PKCE), paste any provider's key
// (the provider is told by the key's prefix), or use a model running on this computer. The key stays
// in this browser (localStorage) and goes only to its provider; providerForRun() hands the runtime
// Worker what providers/llm.mjs needs to call it.
import { useSyncExternalStore } from "react";
import { Cpu, KeyRound, Link2, Unplug } from "lucide-react";
import { PROVIDERS, authHeaders, defaultModel, modelIds, providerForKey } from "./catalog.mjs";

const STORAGE = "alr-ai-provider", VERIFIER = "alr-openrouter-verifier";
const read = (store, key) => { try { return globalThis[store]?.getItem(key) ?? null; } catch { return null; } };
const write = (store, key, value) => {
  try { value === null ? globalThis[store]?.removeItem(key) : globalThis[store]?.setItem(key, value); } catch { /* no storage */ }
};

// ---------------------------------------------------------------- state
const state = {
  connection: (() => { try { return JSON.parse(read("localStorage", STORAGE) ?? "null"); } catch { return null; } })(),
  key: "", code: "", awaitingCode: false, busy: "", message: "", failed: false,
};
let version = 0;
const listeners = new Set();
function emit() {
  version += 1;
  for (const listener of listeners) listener();
  globalThis.dispatchEvent?.(new Event("alr-change"));
}
const useVersion = () => useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  () => version);
const say = (message, failed = false) => { state.message = message; state.failed = failed; emit(); };

/** Whether a provider and model are connected. */
export const providerReady = () => !!state.connection?.model;
/** What the runtime Worker needs to call the connected provider (providers/llm.mjs). */
export const providerForRun = () => state.connection ? { provider: state.connection.provider, apiKey: state.connection.apiKey ?? "",
  model: state.connection.model, baseUrl: PROVIDERS[state.connection.provider].baseUrl } : undefined;

function connect(connection) {
  state.connection = connection;
  write("localStorage", STORAGE, connection ? JSON.stringify(connection) : null);
  state.key = ""; state.code = ""; state.awaitingCode = false;
  emit();
}

/** The provider's models, read with the key: an answer means the key works. */
async function listModels(provider, apiKey) {
  const response = await fetch(`${PROVIDERS[provider].baseUrl}/models`, { headers: authHeaders(provider, apiKey),
    credentials: "omit", referrerPolicy: "no-referrer" });
  if (response.status === 401 || response.status === 403 || response.status === 400)
    throw Object.assign(new Error(`${PROVIDERS[provider].label} did not accept this key.`), { refused: true });
  if (!response.ok) throw new Error(`${PROVIDERS[provider].label} did not list its models (${response.status}).`);
  return modelIds(await response.json());
}

async function connectKey() {
  const apiKey = state.key.trim(), provider = providerForKey(apiKey);
  if (!provider) return say("This key's provider could not be told from it. Keys start with sk-or- (OpenRouter), sk-ant- (Anthropic), sk- (OpenAI), AIza (Gemini), gsk_ (Groq) or csk- (Cerebras); Mistral keys are 32 letters and digits.", true);
  state.busy = "key"; say("");
  try {
    if (provider === "openrouter") {
      const check = await fetch(`${PROVIDERS.openrouter.baseUrl}/key`, { headers: authHeaders(provider, apiKey), credentials: "omit" });
      if (!check.ok) throw new Error("OpenRouter did not accept this key.");
    }
    const models = await listModels(provider, apiKey);
    const model = defaultModel(provider, models);
    if (!model) throw new Error(`${PROVIDERS[provider].label} listed no model this page can use.`);
    connect({ provider, apiKey, model, models });
    say(`Connected to ${PROVIDERS[provider].label}.`);
  } catch (error) {
    say(error instanceof TypeError ? `${PROVIDERS[provider].label} could not be reached. Check the connection and try again.` : error.message, true);
  } finally { state.busy = ""; emit(); }
}

async function connectLocal(provider) {
  state.busy = provider; say("");
  try {
    const models = await listModels(provider, "");
    if (!models.length) throw new Error(`${PROVIDERS[provider].label} has no model loaded. Load one, then connect again.`);
    connect({ provider, model: models[0], models });
    say(`Connected to ${PROVIDERS[provider].label} on this computer.`);
  } catch (error) {
    const fromFile = location.protocol === "file:";
    say(!(error instanceof TypeError) ? error.message : provider === "ollama"
      ? `Ollama did not answer at localhost:11434. Start it${fromFile ? " with OLLAMA_ORIGINS=* set, which lets a page opened from a file reach it," : ""} and try again.`
      : "LM Studio did not answer at localhost:1234. Start its server with Enable CORS turned on (Developer tab), and try again.", true);
  } finally { state.busy = ""; emit(); }
}

// ---------------------------------------------------------------- OpenRouter (OAuth PKCE)
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
async function startOpenRouter() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (location.protocol === "file:") {
    // A page opened from a file cannot be returned to: OpenRouter shows the code to paste here.
    write("sessionStorage", VERIFIER, verifier);
    state.awaitingCode = true; say("");
    window.open(url, "_blank", "noopener");
    return;
  }
  write("sessionStorage", VERIFIER, verifier);
  url.searchParams.set("callback_url", `${location.origin}${location.pathname}`);
  location.assign(url);
}

async function finishOpenRouter(code) {
  const verifier = read("sessionStorage", VERIFIER);
  if (!verifier) return say("Start Connect OpenRouter again: this page no longer has the request it sent.", true);
  state.busy = "openrouter"; say("");
  try {
    const response = await fetch(`${PROVIDERS.openrouter.baseUrl}/auth/keys`, { method: "POST", credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim(), code_verifier: verifier, code_challenge_method: "S256" }) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.key) throw new Error("OpenRouter did not accept that code. Start Connect OpenRouter again.");
    write("sessionStorage", VERIFIER, null);
    const models = await listModels("openrouter", payload.key);
    connect({ provider: "openrouter", apiKey: payload.key, model: defaultModel("openrouter", models), models });
    say("Connected to OpenRouter.");
  } catch (error) {
    say(error instanceof TypeError ? "OpenRouter could not be reached. Check the connection and try again." : error.message, true);
  } finally { state.busy = ""; emit(); }
}

// Back from OpenRouter on a hosted or localhost page: the code is in the address.
if (typeof location !== "undefined" && location.protocol !== "file:") {
  const code = new URLSearchParams(location.search).get("code");
  if (code && read("sessionStorage", VERIFIER)) {
    history.replaceState(null, "", `${location.pathname}${location.hash}`);
    void finishOpenRouter(code);
  }
}

// ---------------------------------------------------------------- view
export function ProviderPanel() {
  useVersion();
  const { connection, busy } = state;
  const detected = providerForKey(state.key);
  const models = connection?.models ?? [];
  return <div className="providers">
    <div className={`provider-status${connection ? " connected" : ""}`}>
      {connection ? <>
        <span className="provider-dot" aria-hidden />
        <span className="provider-name">{PROVIDERS[connection.provider].label}</span>
        <select aria-label="Model" value={connection.model} onChange={(event) => connect({ ...connection, model: event.target.value })}>
          {[...new Set([connection.model, ...models])].map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
        <button type="button" className="button quiet small" onClick={() => { connect(null); say(""); }}><Unplug aria-hidden />Disconnect</button>
      </> : <span className="muted">No provider connected.</span>}
    </div>

    <div className="provider-way">
      <button type="button" className="button secondary" disabled={!!busy} onClick={() => void startOpenRouter()}>
        {busy === "openrouter" ? <span className="spinner" /> : <Link2 aria-hidden />}Connect OpenRouter</button>
      <span className="option-detail">Opens OpenRouter to sign in and approve a key for this page. Its free models need no payment.</span>
    </div>
    {state.awaitingCode && <div className="provider-row">
      <input type="text" value={state.code} placeholder="Code shown by OpenRouter" spellCheck={false} aria-label="Code shown by OpenRouter"
        onChange={(event) => { state.code = event.target.value; emit(); }} />
      <button type="button" className="button secondary small" disabled={!state.code.trim() || !!busy}
        onClick={() => void finishOpenRouter(state.code)}>Finish</button>
    </div>}

    <div className="field provider-key">
      <label className="option-label" htmlFor="alr-provider-key">API key</label>
      <div className="provider-row">
        <input id="alr-provider-key" type="password" value={state.key} autoComplete="off" spellCheck={false}
          placeholder="OpenAI, Anthropic, Gemini, Groq, Cerebras, OpenRouter or Mistral"
          onChange={(event) => { state.key = event.target.value; emit(); }}
          onKeyDown={(event) => { if (event.key === "Enter" && detected) void connectKey(); }} />
        <button type="button" className="button secondary small" disabled={!state.key.trim() || !!busy} onClick={() => void connectKey()}>
          {busy === "key" ? <span className="spinner" /> : <KeyRound aria-hidden />}Connect</button>
      </div>
      <span className="option-detail">{state.key.trim()
        ? detected ? `${PROVIDERS[detected].label} key.` : "This key's provider is not recognized."
        : "The key is kept in this browser and sent only to its provider."}</span>
    </div>

    <div className="provider-way">
      <span className="option-label">Model on this computer</span>
      <div className="provider-row">
        {["ollama", "lmstudio"].map((provider) => <button key={provider} type="button" className="button secondary small"
          disabled={!!busy} onClick={() => void connectLocal(provider)}>
          {busy === provider ? <span className="spinner" /> : <Cpu aria-hidden />}{PROVIDERS[provider].label}</button>)}
      </div>
    </div>

    <p className="provider-note">Gemini's free tier and Mistral's free plan may use what you send to train their models, and
      OpenRouter's free models run on providers that may keep or train on it, so don't send confidential drafts through them.
      OpenAI and Anthropic don't train on API requests by default, Groq and Cerebras say they don't keep them,
      and Ollama and LM Studio keep everything on this computer.</p>
    <p className={`provider-message${state.failed ? " failed" : ""}`} aria-live="polite">{state.message || " "}</p>
  </div>;
}

if (typeof document !== "undefined" && !document.getElementById("alr-provider-styles")) {
  const style = document.createElement("style");
  style.id = "alr-provider-styles";
  style.textContent = `
.providers { display: grid; gap: 12px; min-width: 0; }
.provider-status { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 6px 8px 6px 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(0, 0, 0, 0.12); min-width: 0; }
.provider-status.connected { border-color: var(--accent); background: var(--accent-soft); }
.provider-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--perfect); flex: none; }
.provider-name { font-weight: 600; white-space: nowrap; }
.provider-status select { flex: 1; min-width: 0; height: 30px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); }
.provider-way { display: grid; gap: 6px; }
.provider-way > .button { justify-self: start; }
.provider-row { display: flex; gap: 8px; min-width: 0; }
.provider-row input { flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--panel); }
.provider-key input { max-width: none; }
.provider-note { color: var(--ink-muted); font-size: 12.5px; line-height: 1.45; }
.provider-message { min-height: 1.45em; color: var(--ink-muted); font-size: 12.5px; }
.provider-message.failed { color: var(--no-match); }
`;
  document.head.append(style);
}
