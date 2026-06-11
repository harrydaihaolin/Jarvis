# Fireworks AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `providers/` abstraction to the proxy so Fireworks AI is the primary LLM and Claude is the automatic fallback, with zero changes to the agent tool loop or heartbeat.

**Architecture:** A thin `providers/` layer exposes one method — `streamTurn(params, onText)` — that returns an Anthropic-shaped `finalMessage`. `agent.js` calls the provider instead of the Anthropic SDK directly. `index.js` picks Fireworks when `FIREWORKS_API_KEY` is set and wraps the call with a Claude fallback on error.

**Tech Stack:** Node 22 ESM, native `fetch`, `@anthropic-ai/sdk`, `node:test` + `node:assert/strict`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `proxy/src/providers/anthropic.js` | Wraps Anthropic SDK stream; returns Anthropic-shaped finalMessage |
| Create | `proxy/src/providers/fireworks.js` | Calls Fireworks OpenAI-compat API; normalises SSE → Anthropic finalMessage shape |
| Create | `proxy/src/providers/index.js` | Selects provider from env; wraps fallback logic |
| Create | `proxy/src/providers/anthropic.test.js` | Smoke-tests the extracted provider interface |
| Create | `proxy/src/providers/fireworks.test.js` | Unit-tests SSE normalisation and message/tool conversion (no network) |
| Create | `proxy/src/providers/index.test.js` | Tests fallback: throws on Fireworks, asserts Claude is called |
| Modify | `proxy/src/agent.js` | Replace `anthropic.messages.stream()` with `provider.streamTurn()` |
| Modify | `proxy/src/agent.test.js` | Replace `fakeAnthropic` with `fakeProvider` matching new interface |
| Modify | `proxy/src/server.js` | Read Fireworks env vars; create provider; pass `provider` to `runAgent` |

---

## Task 1: Create `proxy/src/providers/anthropic.js`

**Files:**
- Create: `proxy/src/providers/anthropic.js`
- Create: `proxy/src/providers/anthropic.test.js`

- [ ] **Step 1: Write the failing test**

```js
// proxy/src/providers/anthropic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicProvider } from "./anthropic.js";

test("createAnthropicProvider returns an object with streamTurn", () => {
  const provider = createAnthropicProvider({ apiKey: "test-key" });
  assert.equal(typeof provider.streamTurn, "function");
});

test("streamTurn calls onText for each text delta", async () => {
  const fakeClient = {
    messages: {
      stream(_params) {
        const listeners = {};
        return {
          on(event, cb) { listeners[event] = cb; return this; },
          finalMessage: async () => {
            listeners.text?.("hello ");
            listeners.text?.("world");
            return { stop_reason: "end_turn", content: [{ type: "text", text: "hello world" }] };
          },
        };
      },
    },
  };

  const provider = createAnthropicProvider({ apiKey: "k", _clientOverride: fakeClient });
  let collected = "";
  const result = await provider.streamTurn(
    { model: "m", max_tokens: 64, system: [], tools: [], messages: [] },
    (delta) => { collected += delta; }
  );

  assert.equal(collected, "hello world");
  assert.equal(result.stop_reason, "end_turn");
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd proxy && node --test src/providers/anthropic.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` or `cannot find module './anthropic.js'`

- [ ] **Step 3: Create `proxy/src/providers/anthropic.js`**

```js
import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicProvider({ apiKey, _clientOverride }) {
  const client = _clientOverride ?? new Anthropic({ apiKey });
  return {
    async streamTurn({ model, max_tokens, temperature, system, tools, messages }, onText) {
      const stream = client.messages.stream({
        model,
        max_tokens,
        ...(typeof temperature === "number" ? { temperature } : {}),
        system,
        tools,
        messages,
      });
      if (onText) stream.on("text", (delta) => onText(delta));
      return stream.finalMessage();
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd proxy && node --test src/providers/anthropic.test.js
```

Expected: `✓ createAnthropicProvider returns an object with streamTurn`, `✓ streamTurn calls onText for each text delta`

- [ ] **Step 5: Commit**

```bash
git add proxy/src/providers/anthropic.js proxy/src/providers/anthropic.test.js
git commit -m "feat(providers): extract Anthropic provider module"
```

---

## Task 2: Create `proxy/src/providers/fireworks.js`

**Files:**
- Create: `proxy/src/providers/fireworks.js`
- Create: `proxy/src/providers/fireworks.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// proxy/src/providers/fireworks.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toOpenAIMessages, toOpenAITools, buildFinalMessage } from "./fireworks.js";

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
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd proxy && node --test src/providers/fireworks.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` or named-export errors

- [ ] **Step 3: Create `proxy/src/providers/fireworks.js`**

```js
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
  return {
    stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
    content,
  };
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
}

export function createFireworksProvider({ apiKey, model }) {
  return {
    async streamTurn({ max_tokens, temperature, system, tools, messages }, onText) {
      const body = {
        model,
        max_tokens,
        messages: toOpenAIMessages(system, messages),
        stream: true,
        ...(typeof temperature === "number" ? { temperature } : {}),
      };
      const openaiTools = toOpenAITools(tools ?? []);
      if (openaiTools.length) body.tools = openaiTools;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let resp;
      try {
        resp = await fetch(`${FIREWORKS_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

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
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd proxy && node --test src/providers/fireworks.test.js
```

Expected: all 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add proxy/src/providers/fireworks.js proxy/src/providers/fireworks.test.js
git commit -m "feat(providers): add Fireworks AI provider with SSE normalisation"
```

---

## Task 3: Create `proxy/src/providers/index.js`

**Files:**
- Create: `proxy/src/providers/index.js`
- Create: `proxy/src/providers/index.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// proxy/src/providers/index.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

// createProvider reads from env, so we inject env directly.
// We can't easily mock the sub-imports in ESM without dynamic import tricks,
// so we test the provider's external behaviour via a monkey-patchable factory.
import { createProvider } from "./index.js";

test("returns Claude-only provider when FIREWORKS_API_KEY is unset", async () => {
  let anthropicCalled = false;
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "",
    _anthropicFactory: ({ apiKey }) => ({
      async streamTurn(params, onText) {
        anthropicCalled = true;
        onText?.("hi");
        return { stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] };
      },
    }),
  };
  const provider = createProvider(env);
  const result = await provider.streamTurn({ model: "m", max_tokens: 64, system: [], tools: [], messages: [] }, null);
  assert.ok(anthropicCalled);
  assert.equal(result.stop_reason, "end_turn");
});

test("falls back to Claude when Fireworks throws and FIREWORKS_FALLBACK_ENABLED=true", async () => {
  const calls = [];
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "fw-key",
    FIREWORKS_MODEL: "accounts/fireworks/models/test",
    FIREWORKS_FALLBACK_ENABLED: "true",
    _anthropicFactory: () => ({
      async streamTurn() {
        calls.push("claude");
        return { stop_reason: "end_turn", content: [] };
      },
    }),
    _fireworksFactory: () => ({
      async streamTurn() {
        calls.push("fireworks");
        throw Object.assign(new Error("503 Service Unavailable"), { status: 503 });
      },
    }),
  };
  const provider = createProvider(env);
  await provider.streamTurn({ model: "m", max_tokens: 64, system: [], tools: [], messages: [] }, null);
  assert.deepEqual(calls, ["fireworks", "claude"]);
});

test("throws when Fireworks fails and FIREWORKS_FALLBACK_ENABLED=false", async () => {
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "fw-key",
    FIREWORKS_MODEL: "accounts/fireworks/models/test",
    FIREWORKS_FALLBACK_ENABLED: "false",
    _anthropicFactory: () => ({ async streamTurn() { return { stop_reason: "end_turn", content: [] }; } }),
    _fireworksFactory: () => ({
      async streamTurn() { throw Object.assign(new Error("500"), { status: 500 }); },
    }),
  };
  const provider = createProvider(env);
  await assert.rejects(
    () => provider.streamTurn({ model: "m", max_tokens: 64, system: [], tools: [], messages: [] }, null),
    /500/
  );
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd proxy && node --test src/providers/index.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` or named-export errors

- [ ] **Step 3: Create `proxy/src/providers/index.js`**

```js
import { createAnthropicProvider } from "./anthropic.js";
import { createFireworksProvider } from "./fireworks.js";

/**
 * createProvider reads env vars and returns the right provider.
 * Pass _anthropicFactory / _fireworksFactory in env for testing.
 */
export function createProvider(env = process.env) {
  const {
    ANTHROPIC_API_KEY,
    FIREWORKS_API_KEY,
    FIREWORKS_MODEL = "accounts/fireworks/models/llama-v3p3-70b-instruct",
    FIREWORKS_FALLBACK_ENABLED = "true",
    _anthropicFactory = createAnthropicProvider,
    _fireworksFactory = createFireworksProvider,
  } = env;

  const claude = _anthropicFactory({ apiKey: ANTHROPIC_API_KEY });

  if (!FIREWORKS_API_KEY) return claude;

  const fireworks = _fireworksFactory({ apiKey: FIREWORKS_API_KEY, model: FIREWORKS_MODEL });
  const fallbackEnabled = FIREWORKS_FALLBACK_ENABLED !== "false";

  return {
    async streamTurn(params, onText) {
      try {
        return await fireworks.streamTurn(params, onText);
      } catch (err) {
        if (!fallbackEnabled) throw err;
        console.error(`[provider] Fireworks failed (${err.message}), falling back to Claude`);
        return claude.streamTurn(params, onText);
      }
    },
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd proxy && node --test src/providers/index.test.js
```

Expected: all 3 tests pass

- [ ] **Step 5: Run all provider tests together**

```bash
cd proxy && node --test src/providers/
```

Expected: all 11 tests pass

- [ ] **Step 6: Commit**

```bash
git add proxy/src/providers/index.js proxy/src/providers/index.test.js
git commit -m "feat(providers): add provider index with Fireworks-primary + Claude fallback"
```

---

## Task 4: Update `proxy/src/agent.js` and `proxy/src/agent.test.js`

**Files:**
- Modify: `proxy/src/agent.js` — lines 102, 116–127
- Modify: `proxy/src/agent.test.js`

- [ ] **Step 1: Update `agent.test.js` to use `fakeProvider`**

Replace the entire `fakeStream` and `fakeAnthropic` block (lines 12–33) with `fakeProvider`, and update all three test calls from `anthropic:` to `provider:`:

```js
// proxy/src/agent.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent } from "./agent.js";

const env = { AGENT_WORKSPACE: mkdtempSync(path.join(tmpdir(), "agent-")) };
const cfg = { webSearch: false, enableCommands: false, maxIterations: 8 };

function fakeProvider(scripted) {
  let i = 0;
  return {
    async streamTurn(_params, onText) {
      const step = scripted[Math.min(i, scripted.length - 1)];
      i += 1;
      if (onText && step.text) for (const t of step.text) onText(t);
      return step.final;
    },
  };
}

test("runs a tool then streams the final answer", async () => {
  const provider = fakeProvider([
    {
      text: ["Let me check. "],
      final: {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me check. " },
          { type: "tool_use", id: "t1", name: "list_dir", input: { path: "." } },
        ],
      },
    },
    {
      text: ["The folder is empty."],
      final: { stop_reason: "end_turn", content: [{ type: "text", text: "The folder is empty." }] },
    },
  ]);

  let out = "";
  const events = [];
  const { finishReason } = await runAgent({
    provider,
    baseParams: { model: "m", max_tokens: 256, messages: [{ role: "user", content: "what's in my workspace?" }] },
    cfg,
    env,
    onText: (t) => (out += t),
    onEvent: (e) => events.push(e),
  });

  assert.equal(out, "Let me check. The folder is empty.");
  assert.equal(finishReason, "stop");
  assert.ok(events.some((e) => e.type === "tool_call" && e.name === "list_dir"));
});

test("handles pause_turn (server tool) then finishes", async () => {
  const provider = fakeProvider([
    { text: ["Searching… "], final: { stop_reason: "pause_turn", content: [{ type: "text", text: "Searching… " }] } },
    { text: ["Here's what I found."], final: { stop_reason: "end_turn", content: [{ type: "text", text: "Here's what I found." }] } },
  ]);
  let out = "";
  const { finishReason } = await runAgent({
    provider,
    baseParams: { model: "m", max_tokens: 256, messages: [{ role: "user", content: "search x" }] },
    cfg,
    env,
    onText: (t) => (out += t),
  });
  assert.equal(out, "Searching… Here's what I found.");
  assert.equal(finishReason, "stop");
});

test("respects the iteration cap when tools loop forever", async () => {
  const provider = fakeProvider([
    {
      text: ["."],
      final: {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t", name: "list_dir", input: { path: "." } }],
      },
    },
  ]);
  let calls = 0;
  const { iterations } = await runAgent({
    provider,
    baseParams: { model: "m", max_tokens: 64, messages: [{ role: "user", content: "loop" }] },
    cfg: { ...cfg, maxIterations: 3 },
    env,
    onText: () => (calls += 1),
  });
  assert.equal(iterations, 3);
});
```

- [ ] **Step 2: Run agent tests to confirm they fail (expected — agent.js not updated yet)**

```bash
cd proxy && node --test src/agent.test.js
```

Expected: tests fail because `runAgent` still expects `anthropic`, not `provider`

- [ ] **Step 3: Update `proxy/src/agent.js`**

Change line 102 — the function signature:
```js
// BEFORE:
export async function runAgent({ anthropic, baseParams, cfg, env = process.env, onText, onEvent }) {

// AFTER:
export async function runAgent({ provider, baseParams, cfg, env = process.env, onText, onEvent }) {
```

Change lines 116–127 — the stream call:
```js
// BEFORE:
    const stream = anthropic.messages.stream({
      model: baseParams.model,
      max_tokens: baseParams.max_tokens,
      ...(typeof baseParams.temperature === "number" ? { temperature: baseParams.temperature } : {}),
      system,
      tools,
      messages,
    });

    if (onText) stream.on("text", (delta) => onText(delta));

    const final = await stream.finalMessage();

// AFTER:
    const final = await provider.streamTurn(
      {
        model: baseParams.model,
        max_tokens: baseParams.max_tokens,
        ...(typeof baseParams.temperature === "number" ? { temperature: baseParams.temperature } : {}),
        system,
        tools,
        messages,
      },
      onText ?? null
    );
```

- [ ] **Step 4: Run agent tests to confirm they pass**

```bash
cd proxy && node --test src/agent.test.js
```

Expected: all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add proxy/src/agent.js proxy/src/agent.test.js
git commit -m "refactor(agent): replace Anthropic SDK call with provider.streamTurn()"
```

---

## Task 5: Update `proxy/src/server.js`

**Files:**
- Modify: `proxy/src/server.js`

- [ ] **Step 1: Add the provider import and new env vars**

After the existing imports at the top of `server.js`, add:
```js
import { createProvider } from "./providers/index.js";
```

In the `process.env` destructuring block (around line 24), add three new vars after `NOTION_MCP_TOKEN`:
```js
  FIREWORKS_API_KEY = "",
  FIREWORKS_MODEL = "accounts/fireworks/models/llama-v3p3-70b-instruct",
  FIREWORKS_FALLBACK_ENABLED = "true",
```

- [ ] **Step 2: Create the provider instance after the `anthropic` client**

After line 50 (`const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });`), add:
```js
const provider = createProvider(process.env);
```

Also update the startup log line (around line 289) to show which LLM is active:
```js
// BEFORE:
    console.log(`[proxy] model=${ANTHROPIC_MODEL}  auth=...`);

// AFTER:
    const primaryModel = FIREWORKS_API_KEY ? FIREWORKS_MODEL : ANTHROPIC_MODEL;
    console.log(`[proxy] model=${primaryModel}  fallback=${FIREWORKS_API_KEY ? ANTHROPIC_MODEL : "none"}  auth=${PROXY_ALLOW_UNAUTHENTICATED === "true" || !PROXY_API_KEY ? "disabled" : "enabled"}`);
```

- [ ] **Step 3: Wire `provider` into both `runAgent` calls**

There are two `runAgent` calls in `handleChatCompletions`. Change `anthropic` → `provider` in both:

Non-streaming path (around line 172):
```js
// BEFORE:
      const { finishReason, messages } = await runAgent({
        anthropic,
        baseParams: params,

// AFTER:
      const { finishReason, messages } = await runAgent({
        provider,
        baseParams: params,
```

Streaming path (around line 222):
```js
// BEFORE:
      ({ finishReason, messages } = await runAgent({
        anthropic,
        baseParams: params,

// AFTER:
      ({ finishReason, messages } = await runAgent({
        provider,
        baseParams: params,
```

- [ ] **Step 4: Run the full test suite**

```bash
cd proxy && npm test
```

Expected: all tests pass (agent, conversation, translate, providers)

- [ ] **Step 5: Commit**

```bash
git add proxy/src/server.js
git commit -m "feat(server): wire Fireworks provider; primary LLM with Claude fallback"
```

---

## Task 6: Smoke-test the running proxy

- [ ] **Step 1: Start the proxy**

```bash
cd proxy && npm start
```

Expected log output:
```
[proxy] memory: "jarvis-memory" → <store-id>
[proxy] listening on http://localhost:8787
[proxy] model=accounts/fireworks/models/llama-v3p3-70b-instruct  fallback=claude-haiku-4-5-20251001  auth=enabled
```

- [ ] **Step 2: Send a test request**

```bash
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep PROXY_API_KEY ../.env | cut -d= -f2)" \
  -d '{"model":"test","stream":false,"messages":[{"role":"user","content":"say the word hello and nothing else"}]}'
```

Expected: JSON response containing `"hello"` in the message content

- [ ] **Step 3: Verify fallback by temporarily breaking the Fireworks key**

```bash
FIREWORKS_API_KEY=bad-key node src/server.js &
sleep 2
curl -s -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep PROXY_API_KEY ../.env | cut -d= -f2)" \
  -d '{"model":"test","stream":false,"messages":[{"role":"user","content":"say the word hello"}]}'
```

Expected: proxy stderr shows `[provider] Fireworks failed`, response still contains `"hello"` (from Claude)

```bash
kill %1
```

- [ ] **Step 4: Commit smoke-test confirmation** *(no code change — this is a manual gate)*

```bash
git tag fireworks-provider-verified
```
