// Translation between the OpenAI Chat Completions shape and the Anthropic Messages API.

/** Flatten OpenAI message content (string | array of parts) into plain text. */
export function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return String(content);
}

const EMOTION_TAG_PATTERNS = [
  /<emotion\b[^>]*\/?>/gi,
  /<\/emotion>/gi,
];

/** Strip <emotion/> tags from agent output, leaving only spoken text. */
export function cleanSpokenText(raw) {
  let text = contentToText(raw);
  for (const re of EMOTION_TAG_PATTERNS) text = text.replace(re, " ");
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text of the most recent user message. */
export function lastSpokenUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== "user") continue;
    const text = contentToText(list[i].content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Convert an OpenAI Chat Completions request body into Anthropic Messages params.
 * - `system` / `developer` role messages are hoisted into the top-level `system`.
 * - Consecutive same-role messages are merged (Anthropic requires alternation).
 * - The first message is forced to `user` (Anthropic requires the convo to start with user).
 */
export function openaiToAnthropic(body, { defaultModel, defaultMaxTokens }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const systemParts = [];
  const convo = [];
  for (const m of messages) {
    const role = m.role;
    const text = contentToText(m.content);
    if (role === "system" || role === "developer") {
      if (text) systemParts.push(text);
      continue;
    }
    // Map anything that isn't user/assistant (e.g. "tool") onto user so context survives.
    const anthropicRole = role === "assistant" ? "assistant" : "user";
    convo.push({ role: anthropicRole, text });
  }

  // Merge consecutive same-role turns.
  const merged = [];
  for (const turn of convo) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.text = `${last.text}\n\n${turn.text}`.trim();
    } else {
      merged.push({ ...turn });
    }
  }

  // Anthropic must start with a user turn.
  if (merged.length && merged[0].role !== "user") {
    merged.unshift({ role: "user", text: "(conversation start)" });
  }

  const anthropicMessages = merged.map((t) => ({
    role: t.role,
    content: t.text || "(empty)",
  }));

  const params = {
    model: body.model || defaultModel,
    max_tokens: clampInt(body.max_tokens ?? body.max_completion_tokens, defaultMaxTokens, 1, 8192),
    messages: anthropicMessages,
  };
  const system = systemParts.join("\n\n").trim();
  if (system) params.system = system;
  if (typeof body.temperature === "number") params.temperature = body.temperature;
  if (typeof body.top_p === "number") params.top_p = body.top_p;
  if (Array.isArray(body.stop)) params.stop_sequences = body.stop;
  else if (typeof body.stop === "string") params.stop_sequences = [body.stop];

  return params;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Map an Anthropic stop_reason to an OpenAI finish_reason. */
export function mapFinishReason(stopReason) {
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

/** Build one OpenAI-style streaming chunk. */
export function streamChunk({ id, created, model, delta = {}, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Build a non-streaming OpenAI-style completion response. */
export function completionResponse({ id, created, model, text, finishReason, usage }) {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: usage ?? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}
