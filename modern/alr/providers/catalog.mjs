// The AI providers the page calls directly with the user's own key, each verified (2026-10-04) to
// answer a page opened from a file (Origin: null): its models list and its chat endpoint send
// Access-Control-Allow-Origin. Each names the models to prefer, first match in the provider's own
// list wins: a free-tier model where the provider has one, else its cheapest capable model.
// A model is matched by exact id, or by a pattern, newest first.

export const PROVIDERS = {
  openrouter: {
    label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyPattern: /^sk-or-/u,
    // Free models that list structured outputs (openrouter.ai/api/v1/models supported_parameters).
    prefer: ["nvidia/nemotron-3-super-120b-a12b:free", "qwen/qwen3.8-27b:free", "google/gemma-4-31b-it:free", /:free$/u],
    headers: { "X-Title": "ALR Quote Verifier" },
  },
  anthropic: {
    label: "Anthropic", baseUrl: "https://api.anthropic.com/v1", keyPattern: /^sk-ant-/u,
    prefer: [/haiku/u, /sonnet/u],
  },
  openai: {
    label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyPattern: /^sk-(?!ant-|or-)/u,
    prefer: ["gpt-6-luna", /luna/u, /mini/u],
  },
  gemini: {
    label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyPattern: /^AIza/u,
    prefer: ["gemini-3.8-flash", "models/gemini-3.8-flash", /flash(?!.*(?:lite|image|tts|audio|live))/u, /flash/u],
  },
  groq: {
    label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyPattern: /^gsk_/u,
    prefer: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"],
  },
  cerebras: {
    label: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", keyPattern: /^csk-/u,
    prefer: ["gpt-oss-120b", /qwen/u],
  },
  // Mistral's keys have no prefix: 32 letters and digits.
  mistral: {
    label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyPattern: /^[A-Za-z0-9]{32}$/u,
    prefer: ["mistral-small-latest", "mistral-medium-latest", /^mistral-small/u],
  },
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434/v1", local: true, prefer: [] },
  lmstudio: { label: "LM Studio", baseUrl: "http://localhost:1234/v1", local: true, prefer: [] },
};

/** The provider a pasted key belongs to, by its prefix, or null. */
export function providerForKey(key) {
  const value = key.trim();
  return Object.entries(PROVIDERS).find(([, provider]) => provider.keyPattern?.test(value))?.[0] ?? null;
}

/** The request headers a provider's API takes the key in. */
export function authHeaders(provider, apiKey) {
  if (provider === "anthropic") return { "x-api-key": apiKey, "anthropic-version": "2023-06-01",
    // Anthropic answers a browser only when it says it calls from one.
    "anthropic-dangerous-direct-browser-access": "true" };
  return { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...PROVIDERS[provider].headers };
}

/** Model ids from a provider's models list, newest first where it says when they were made. */
export function modelIds(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return rows.map((row) => ({ id: String(row.id ?? row.name ?? ""), created: Date.parse(row.created_at ?? "") ||
    Number(row.created ?? 0) * 1000 || 0 }))
    .filter((row) => row.id && !/embed|whisper|tts|dall-e|moderation|guard|image|audio|transcri|realtime/iu.test(row.id))
    .sort((left, right) => right.created - left.created).map((row) => row.id);
}

/** The model to start with: the first preference the provider lists, else its first model. */
export function defaultModel(provider, ids) {
  for (const choice of PROVIDERS[provider].prefer) {
    const found = typeof choice === "string" ? ids.find((id) => id === choice) : ids.find((id) => choice.test(id));
    if (found) return found.replace(/^models\//u, "");
  }
  return ids[0]?.replace(/^models\//u, "") ?? "";
}
