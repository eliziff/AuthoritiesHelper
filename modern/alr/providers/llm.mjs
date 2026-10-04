// The verifier's model client (backend/src/lib/alrVerifier llm: complete(messages, { schema })) over
// the provider the user connected (providers/panel.jsx). It runs in the runtime Worker: fetch only.
// OpenAI-compatible providers (OpenAI, OpenRouter, Gemini, Groq, Cerebras, Mistral, Ollama, LM Studio)
// answer to a JSON schema through response_format; Anthropic through a tool the model must call.
import { PROVIDERS, authHeaders } from "./catalog.mjs";

const RETRIES = 2;
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

async function post(url, headers, body, signal) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { method: "POST", signal, credentials: "omit", referrerPolicy: "no-referrer",
        headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    } catch (error) {
      signal?.throwIfAborted();
      // OpenAI and Cerebras refuse a wrong key without letting the page read why.
      throw new Error("The AI provider could not be reached, or refused the key. Check the key in Settings.", { cause: error });
    }
    if (response.ok) return response.json();
    const detail = await response.text().catch(() => "");
    // A limit or a busy server is waited out a little; anything else is the answer.
    if ((response.status === 429 || response.status >= 500) && attempt < RETRIES) {
      const after = Number(response.headers.get("retry-after"));
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 2000 * (attempt + 1), signal);
      continue;
    }
    const message = (() => { try { const parsed = JSON.parse(detail); return parsed.error?.message ?? parsed.message ?? parsed.detail; } catch { return ""; } })();
    throw Object.assign(new Error(`The AI provider answered ${response.status}${message ? `: ${message}` : "."}`),
      { status: response.status });
  }
}

function openAiCompatible(config) {
  const url = `${config.baseUrl ?? PROVIDERS[config.provider].baseUrl}/chat/completions`;
  const headers = authHeaders(config.provider, config.apiKey);
  return async (messages, { schema, signal } = {}) => {
    const body = { model: config.model, messages, temperature: 0 };
    let payload;
    if (schema) {
      try {
        payload = await post(url, headers, { ...body,
          response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } } }, signal);
      } catch (error) {
        // A model that does not take a schema still answers in JSON when asked for it.
        if (error.status !== 400) throw error;
        payload = await post(url, headers, { ...body, response_format: { type: "json_object" },
          messages: [...messages, { role: "system", content: `Answer with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` }] }, signal);
      }
    } else payload = await post(url, headers, body, signal);
    const usage = payload.usage ?? {};
    return {
      text: payload.choices?.[0]?.message?.content ?? "",
      usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0,
        cached_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    };
  };
}

function anthropic(config) {
  const url = `${PROVIDERS.anthropic.baseUrl}/messages`, headers = authHeaders("anthropic", config.apiKey);
  return async (messages, { schema, signal } = {}) => {
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    const body = { model: config.model, max_tokens: 16_000, temperature: 0,
      ...(system ? { system } : {}), messages: messages.filter((message) => message.role !== "system"),
      ...(schema ? { tools: [{ name: "answer", description: "Give the answer.", input_schema: schema }],
        tool_choice: { type: "tool", name: "answer" } } : {}) };
    const payload = await post(url, headers, body, signal);
    const content = payload.content ?? [];
    const tool = content.find((part) => part.type === "tool_use");
    const usage = payload.usage ?? {};
    return {
      text: tool ? JSON.stringify(tool.input) : content.filter((part) => part.type === "text").map((part) => part.text).join(""),
      usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0,
        cached_input_tokens: usage.cache_read_input_tokens ?? 0 },
    };
  };
}

/** The verifier's model client for a connected provider ({ provider, apiKey, model, baseUrl? }). */
export function providerLlm(config) {
  if (!PROVIDERS[config?.provider] || !config.model) throw new Error("No AI provider is connected. Connect one in Settings.");
  return { complete: config.provider === "anthropic" ? anthropic(config) : openAiCompatible(config) };
}
