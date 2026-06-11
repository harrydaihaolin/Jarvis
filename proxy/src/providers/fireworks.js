const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const TIMEOUT_MS = 30_000;

/** Anthropic system array + messages → OpenAI messages array */
export function toOpenAIMessages(system, messages) {
  const result = [];

  if (system?.length) {
    const text = system.map((b) => b.text ?? "").join("\n");
    if (text) result.push({ role: "system", content: text });
  }

  for (const msg of messages) {
    const { role, content } = msg;

    if (typeof content === "string") {
      result.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "assistant") {
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      const m = { role: "assistant" };
      if (text) m.content = text;
      if (toolCalls.length) m.tool_calls = toolCalls;
      result.push(m);
    } else if (role === "user") {
      const texts = content.filter((b) => b.type === "text");
      const toolResults = content.filter((b) => b.type === "tool_result");
      if (texts.length) result.push({ role: "user", content: texts.map((b) => b.text).join("") });
      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
        });
      }
    }
  }

  return result;
}

/** Anthropic tool defs → OpenAI tool defs; strips Anthropic server tools */
export function toOpenAITools(tools) {
  return tools
    .filter((t) => !t.type || t.type === "custom")
    .map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
}

/** Accumulated stream state → Anthropic-shaped finalMessage */
export function buildFinalMessage({ text, toolCalls, finishReason }) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const [, tc] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    let input = {};
    try { input = JSON.parse(tc.arguments || "{}"); } catch { /* leave empty */ }
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
  }
  let stop_reason;
  if (toolCalls.size > 0) {
    stop_reason = "tool_use";
  } else if (finishReason === "length") {
    stop_reason = "max_tokens";
  } else if (finishReason === "tool_calls") {
    stop_reason = "tool_use";
  } else {
    stop_reason = "end_turn";
  }
  return { stop_reason, content };
}

async function* readSSE(readable) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of readable) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch { /* skip malformed */ }
    }
  }
  if (buf) {
    if (!buf.startsWith("data: ")) return;
    const data = buf.slice(6).trim();
    if (data === "[DONE]") return;
    try { yield JSON.parse(data); } catch { /* skip malformed */ }
  }
}

export function createFireworksProvider({ apiKey, model, extraBody }) {
  return {
    async streamTurn({ max_tokens, temperature, system, tools, messages }, onText) {
      const body = {
        model,
        max_tokens,
        messages: toOpenAIMessages(system, messages),
        stream: true,
        ...(typeof temperature === "number" ? { temperature } : {}),
        ...(extraBody && typeof extraBody === "object" && Object.keys(extraBody).length > 0
          ? extraBody
          : {}),
      };
      const openaiTools = toOpenAITools(tools ?? []);
      if (openaiTools.length) body.tools = openaiTools;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const resp = await fetch(`${FIREWORKS_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          throw Object.assign(new Error(`Fireworks ${resp.status}: ${errText}`), { status: resp.status });
        }

        const acc = { text: "", toolCalls: new Map(), finishReason: null };

        for await (const chunk of readSSE(resp.body)) {
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (delta.content) {
            acc.text += delta.content;
            onText?.(delta.content);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!acc.toolCalls.has(tc.index)) {
                acc.toolCalls.set(tc.index, { id: tc.id ?? "", name: "", arguments: "" });
              }
              const entry = acc.toolCalls.get(tc.index);
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }
          if (choice.finish_reason) acc.finishReason = choice.finish_reason;
        }

        return buildFinalMessage(acc);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
