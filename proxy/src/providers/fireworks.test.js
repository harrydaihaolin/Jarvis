// proxy/src/providers/fireworks.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAIMessages, toOpenAITools, buildFinalMessage, createFireworksProvider } from "./fireworks.js";

// ── toOpenAIMessages ──────────────────────────────────────────────────────────

test("toOpenAIMessages: system array becomes system message", () => {
  const result = toOpenAIMessages(
    [{ type: "text", text: "You are Jarvis.", cache_control: { type: "ephemeral" } }],
    [{ role: "user", content: "hi" }]
  );
  assert.deepEqual(result[0], { role: "system", content: "You are Jarvis." });
  assert.deepEqual(result[1], { role: "user", content: "hi" });
});

test("toOpenAIMessages: assistant text block becomes string content", () => {
  const result = toOpenAIMessages([], [
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
  assert.deepEqual(result[0], { role: "assistant", content: "hello" });
});

test("toOpenAIMessages: assistant tool_use becomes tool_calls", () => {
  const result = toOpenAIMessages([], [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_1", name: "list_dir", input: { path: "." } },
      ],
    },
  ]);
  assert.deepEqual(result[0], {
    role: "assistant",
    tool_calls: [
      { id: "call_1", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } },
    ],
  });
});

test("toOpenAIMessages: user tool_result becomes role:tool message", () => {
  const result = toOpenAIMessages([], [
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" }],
    },
  ]);
  assert.deepEqual(result[0], { role: "tool", tool_call_id: "call_1", content: "file.txt" });
});

// ── toOpenAITools ─────────────────────────────────────────────────────────────

test("toOpenAITools: converts Anthropic tool defs to OpenAI format", () => {
  const result = toOpenAITools([
    {
      name: "list_dir",
      description: "List files",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ]);
  assert.deepEqual(result, [
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ]);
});

test("toOpenAITools: strips server tools like web_search_20250305", () => {
  const result = toOpenAITools([
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    { name: "list_dir", description: "List", input_schema: { type: "object", properties: {} } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].function.name, "list_dir");
});

// ── buildFinalMessage ─────────────────────────────────────────────────────────

test("buildFinalMessage: text only → end_turn", () => {
  const result = buildFinalMessage({
    text: "Hello there",
    toolCalls: new Map(),
    finishReason: "stop",
  });
  assert.equal(result.stop_reason, "end_turn");
  assert.deepEqual(result.content, [{ type: "text", text: "Hello there" }]);
});

test("buildFinalMessage: tool_calls finish_reason → tool_use stop_reason", () => {
  const tc = new Map([[0, { id: "call_1", name: "list_dir", arguments: '{"path":"."}' }]]);
  const result = buildFinalMessage({ text: "", toolCalls: tc, finishReason: "tool_calls" });
  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.content, [
    { type: "tool_use", id: "call_1", name: "list_dir", input: { path: "." } },
  ]);
});

test("buildFinalMessage: mixed text + tool → both in content", () => {
  const tc = new Map([[0, { id: "c1", name: "read_file", arguments: '{"path":"x.md"}' }]]);
  const result = buildFinalMessage({ text: "reading…", toolCalls: tc, finishReason: "tool_calls" });
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[1].type, "tool_use");
});

test("buildFinalMessage: length finish_reason → max_tokens stop_reason", () => {
  const result = buildFinalMessage({ text: "truncated", toolCalls: new Map(), finishReason: "length" });
  assert.equal(result.stop_reason, "max_tokens");
});

test("buildFinalMessage: infers tool_use when tool calls present despite stop finish_reason", () => {
  const tc = new Map([[0, { id: "c1", name: "list_dir", arguments: "{}" }]]);
  const result = buildFinalMessage({ text: "", toolCalls: tc, finishReason: "stop" });
  assert.equal(result.stop_reason, "tool_use");
});

test("createFireworksProvider merges extraBody into the request", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return {
      ok: true,
      body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n');
      })(),
    };
  };
  try {
    const provider = createFireworksProvider({
      apiKey: "k",
      model: "m",
      extraBody: { reasoning_effort: "low" },
    });
    await provider.streamTurn({ max_tokens: 60, system: [], tools: [], messages: [{ role: "user", content: "hi" }] }, null);
    assert.equal(sentBody.reasoning_effort, "low");
    assert.equal(sentBody.model, "m");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
