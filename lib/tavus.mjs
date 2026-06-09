// Shared Tavus helpers used by both the CLI (scripts/setup-tavus.mjs) and the
// frontend dev backend (frontend/server.mjs). All Tavus API access lives here so
// the TAVUS_API_KEY never leaves the server side.

export const TAVUS_BASE = "https://tavusapi.com/v2";

/** Build a config object from environment variables. */
export function configFromEnv(env = process.env) {
  return {
    tavusApiKey: env.TAVUS_API_KEY,
    replicaId: env.TAVUS_REPLICA_ID || "r90bbd427f71",
    personaId: env.TAVUS_PERSONA_ID || "",
    testMode: (env.TAVUS_TEST_MODE ?? "true") === "true",
    anthropicModel: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    proxyApiKey: env.PROXY_API_KEY || "",
    publicProxyBaseUrl: env.PUBLIC_PROXY_BASE_URL || "",
    useHosted: (env.USE_TAVUS_HOSTED_LLM ?? "false") === "true",
    hostedModel: env.TAVUS_HOSTED_MODEL || "tavus-claude-haiku-4.5",
    personaName: env.PERSONA_NAME || "Jarvus",
    systemPrompt:
      env.PERSONA_SYSTEM_PROMPT ||
      "You are Jarvus, a warm, concise conversational video agent powered by Claude.",
    greeting:
      env.PERSONA_GREETING ||
      "Hi! I'm Jarvus, a video agent powered by Claude. What would you like to talk about?",
  };
}

/** Resolve the public URL Tavus uses to reach the proxy (Option B only). */
export async function resolvePublicBaseUrl(cfg, { log = () => {} } = {}) {
  if (cfg.useHosted) return null;
  if (cfg.publicProxyBaseUrl) return cfg.publicProxyBaseUrl.replace(/\/+$/, "");

  // Auto-detect a running ngrok tunnel via its local inspection API.
  try {
    const res = await fetch("http://localhost:4040/api/tunnels");
    const data = await res.json();
    const https = (data.tunnels || []).find((t) => t.public_url?.startsWith("https://"));
    if (https) {
      const url = `${https.public_url.replace(/\/+$/, "")}/v1`;
      log(`Auto-detected ngrok tunnel → ${url}`);
      return url;
    }
  } catch {
    /* ngrok not running */
  }
  throw new Error(
    "Could not determine the proxy's public URL. Start ngrok (`docker compose up` or " +
      "`ngrok http 8787`) or set PUBLIC_PROXY_BASE_URL in .env to your https URL + /v1.",
  );
}

/** Build the persona's `layers.llm` config for the chosen option. */
export async function buildLlmLayer(cfg, opts) {
  if (cfg.useHosted) return { model: cfg.hostedModel };
  const baseUrl = await resolvePublicBaseUrl(cfg, opts);
  const layer = { model: cfg.anthropicModel, base_url: baseUrl, speculative_inference: true };
  if (cfg.proxyApiKey) layer.api_key = cfg.proxyApiKey;
  return layer;
}

/** Authenticated Tavus API call. Throws on non-2xx with the response body. */
export async function tavusFetch(cfg, method, path, body) {
  if (!cfg.tavusApiKey) throw new Error("TAVUS_API_KEY is not set.");
  const res = await fetch(`${TAVUS_BASE}${path}`, {
    method,
    headers: { "x-api-key": cfg.tavusApiKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`Tavus ${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export function buildPersonaPayload(cfg, llmLayer) {
  return {
    persona_name: cfg.personaName,
    system_prompt: cfg.systemPrompt,
    pipeline_mode: "full",
    default_replica_id: cfg.replicaId,
    layers: {
      perception: { perception_model: "raven-1" },
      conversational_flow: { turn_detection_model: "sparrow-1", turn_taking_patience: "high" },
      llm: llmLayer,
    },
  };
}

/** Reuse cfg.personaId if set, otherwise create a new persona. */
export async function ensurePersona(cfg, opts) {
  if (cfg.personaId) return { personaId: cfg.personaId, reused: true };
  const llm = await buildLlmLayer(cfg, opts);
  const payload = buildPersonaPayload(cfg, llm);
  const { persona_id } = await tavusFetch(cfg, "POST", "/personas", payload);
  return { personaId: persona_id, reused: false };
}

export async function createConversation(cfg, personaId) {
  const payload = {
    persona_id: personaId,
    replica_id: cfg.replicaId,
    conversation_name: `${cfg.personaName} — ${new Date().toISOString().slice(0, 16)}`,
    custom_greeting: cfg.greeting,
    test_mode: cfg.testMode,
    properties: { enable_recording: false, max_call_duration: 600 },
  };
  return tavusFetch(cfg, "POST", "/conversations", payload);
}

export async function endConversation(cfg, conversationId) {
  return tavusFetch(cfg, "POST", `/conversations/${conversationId}/end`);
}
