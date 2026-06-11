# Conversation Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce time-to-first-word and eliminate dead air by parallelising tool execution, pre-injecting memory context, tuning the heartbeat, and adding a concurrent preamble stream.

**Architecture:** Phase A makes four targeted changes to `agent.js` and `server.js` (parallel tools, memory injection, heartbeat tuning). Phase C extracts a new `preamble.js` module that fires a tiny fast model call concurrently with the main agent loop, guaranteeing a spoken acknowledgment in ~150 ms regardless of model latency.

**Prerequisites:** The Fireworks provider plan (`2026-06-11-fireworks-provider.md`) must be fully implemented first. This plan assumes `agent.js` already uses `provider.streamTurn()` and `server.js` already creates `provider = createProvider(process.env)`.

**Tech Stack:** Node 22 ESM, `node:test` + `node:assert/strict`, existing `@anthropic-ai/sdk` + Fireworks provider

**Spec:** `docs/superpowers/specs/2026-06-11-conversation-optimization-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `proxy/src/agent.js` | A1: parallel tool execution; A2: remove memory_recall start instruction |
| Modify | `proxy/src/agent.test.js` | A1: add multi-tool parallel correctness test |
| Modify | `proxy/src/memory.js` | A3: add `appendMemoryBlock` pure helper |
| Create | `proxy/src/memory.test.js` | A3: test `appendMemoryBlock` |
| Modify | `proxy/src/server.js` | A3: wire memory injection; A4: heartbeat tuning; C: preamble provider + streaming path |
| Create | `proxy/src/preamble.js` | C: `runWithPreamble` + `PREAMBLE_SYSTEM` |
| Create | `proxy/src/preamble.test.js` | C: ordering, failure, skip-when-empty, skip-when-null |
| Modify | `.env.example` | C: document `FIREWORKS_PREAMBLE_MODEL` + `JARVUS_PREAMBLE_ENABLED` |

---

## Task 1: Parallel tool execution

**Files:**
- Modify: `proxy/src/agent.js` (the `stop === "tool_use"` block, ~lines 150–205)
- Modify: `proxy/src/agent.test.js`

- [ ] **Step 1: Write the failing test**

Add this test at the end of `proxy/src/agent.test.js` (after the three existing tests):

```js
test("executes two tools from one turn and collects both results", async () => {
  const provider = fakeProvider([
    {
      text: ["Checking two things. "],
      final: {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "list_dir", input: { path: "." } },
          { type: "tool_use", id: "t2", name: "list_dir", input: { path: "." } },
        ],
      },
    },
    {
      text: ["Both done."],
      final: { stop_reason: "end_turn", content: [{ type: "text", text: "Both done." }] },
    },
  ]);

  const events = [];
  const { finishReason } = await runAgent({
    provider,
    baseParams: {
      model: "m",
      max_tokens: 256,
      messages: [{ role: "user", content: "check both" }],
    },
    cfg,
    env,
    onText: () => {},
    onEvent: (e) => events.push(e),
  });

  assert.equal(finishReason, "stop");
  const toolCalls = events.filter((e) => e.type === "tool_call");
  assert.equal(toolCalls.length, 2);
  assert.ok(toolCalls.every((e) => e.name === "list_dir"));
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
cd proxy && node --test src/agent.test.js
```

Expected: the new test fails — it works only by coincidence with the current serial loop; confirming the test is wired correctly. The three existing tests should still pass.

- [ ] **Step 3: Replace the serial tool loop with `Promise.all`**

In `proxy/src/agent.js`, find the `if (stop === "tool_use")` block and replace it entirely:

```js
    // Client tools were requested: execute ours, return tool_results, loop.
    if (stop === "tool_use") {
      const toolUses = final.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) {
        // Only server tools in this turn; nothing for us to answer.
        finishReason = "stop";
        break;
      }
      messages.push({ role: "assistant", content: final.content });
      const results = await Promise.all(
        toolUses.map(async (b) => {
          // Long-term memory tools (backed by the managed memory store).
          if (cfg.memory && (b.name === "memory_recall" || b.name === "memory_read" || b.name === "memory_save")) {
            const { anthropic: client, storeId } = cfg.memory;
            let out;
            try {
              if (b.name === "memory_recall") out = await memoryRecall(client, storeId, b.input?.query);
              else if (b.name === "memory_read") out = await memoryRead(client, storeId, b.input?.path);
              else out = await memorySave(client, storeId, b.input?.path, b.input?.content);
            } catch (e) {
              out = `ERROR: ${e.message}`;
            }
            const isErr = typeof out === "string" && out.startsWith("ERROR");
            onEvent?.({ type: "memory", op: b.name.replace("memory_", ""), path: b.input?.path, isError: isErr });
            return { type: "tool_result", tool_use_id: b.id, content: String(out), ...(isErr ? { is_error: true } : {}) };
          }

          // Display-only tool: render in the console, don't execute on disk.
          if (b.name === "show_media") {
            const url = b.input?.url;
            if (b.input?.media_type === "image" && url) {
              sessionImages.push({ url, caption: b.input?.caption || "" });
            }
            onEvent?.({
              type: "media",
              mediaType: b.input?.media_type || "link",
              url,
              caption: b.input?.caption || "",
            });
            return { type: "tool_result", tool_use_id: b.id, content: "Displayed in the user's console." };
          }

          onEvent?.({ type: "tool_call", name: b.name, input: b.input });
          const out = await executeTool(b.name, b.input, { env, cfg });
          const isError = typeof out === "string" && out.startsWith("ERROR");
          onEvent?.({ type: "tool_result", name: b.name, isError });
          return {
            type: "tool_result",
            tool_use_id: b.id,
            content: String(out),
            ...(isError ? { is_error: true } : {}),
          };
        })
      );
      messages.push({ role: "user", content: results });
      continue;
    }
```

- [ ] **Step 4: Run tests to confirm all pass**

```bash
cd proxy && node --test src/agent.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add proxy/src/agent.js proxy/src/agent.test.js
git commit -m "perf(agent): execute multiple tools in parallel with Promise.all"
```

---

## Task 2: Remove `memory_recall` start instruction from AGENT_ADDENDUM

**Files:**
- Modify: `proxy/src/agent.js` (the `AGENT_ADDENDUM` constant, ~lines 9–68)

- [ ] **Step 1: Replace the memory section of `AGENT_ADDENDUM`**

Find this block in `AGENT_ADDENDUM`:

```js
Long-term memory (persists across conversations):
- At the START of a conversation, call memory_recall to remember who you're talking to, their
  preferences, and any ongoing projects — then greet them with that context.
- When you learn something durable — the user's name, preferences, decisions, ongoing work — call
  memory_save so you remember it next time. Use clear paths like /profile/owner.md or /projects/x.md.
- Memory is your own brain; you don't need to ask permission to read or update it.
```

Replace it with:

```js
Long-term memory (persists across conversations):
- Your memory from prior conversations is already loaded above in a <memory> block.
  Use it to greet the user by name and recall ongoing projects without calling any tool.
- When you learn something durable — the user's name, preferences, decisions, ongoing work — call
  memory_save so you remember it next time. Use clear paths like /profile/owner.md or /projects/x.md.
- Use memory_recall mid-conversation to search for something specific not in the injected block.
- Memory is your own brain; you don't need to ask permission to read or update it.
```

- [ ] **Step 2: Run all proxy tests to confirm nothing broke**

```bash
cd proxy && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add proxy/src/agent.js
git commit -m "refactor(agent): remove memory_recall start instruction — context is pre-injected"
```

---

## Task 3: Add `appendMemoryBlock` to `memory.js`

**Files:**
- Modify: `proxy/src/memory.js`
- Create: `proxy/src/memory.test.js`

- [ ] **Step 1: Write the failing tests**

Create `proxy/src/memory.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendMemoryBlock } from "./memory.js";

test("appendMemoryBlock appends block to existing system", () => {
  const result = appendMemoryBlock("You are Jarvis.", "User is Alice.");
  assert.equal(result, "You are Jarvis.\n\n<memory>\nUser is Alice.\n</memory>");
});

test("appendMemoryBlock returns system unchanged when memText is blank", () => {
  assert.equal(appendMemoryBlock("You are Jarvis.", ""), "You are Jarvis.");
  assert.equal(appendMemoryBlock("You are Jarvis.", "   "), "You are Jarvis.");
  assert.equal(appendMemoryBlock("You are Jarvis.", null), "You are Jarvis.");
});

test("appendMemoryBlock handles empty system string", () => {
  const result = appendMemoryBlock("", "User is Alice.");
  assert.equal(result, "<memory>\nUser is Alice.\n</memory>");
});

test("appendMemoryBlock trims whitespace from memText", () => {
  const result = appendMemoryBlock("Base.", "  context  ");
  assert.ok(result.includes("<memory>\ncontext\n</memory>"));
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
cd proxy && node --test src/memory.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` or named-export error for `appendMemoryBlock`.

- [ ] **Step 3: Add `appendMemoryBlock` to `memory.js`**

Append at the end of `proxy/src/memory.js`:

```js
/**
 * Append a <memory> block to a system prompt string.
 * Returns system unchanged if memText is blank.
 */
export function appendMemoryBlock(system, memText) {
  const trimmed = String(memText ?? "").trim();
  if (!trimmed) return system ?? "";
  const block = `<memory>\n${trimmed}\n</memory>`;
  return system ? `${system}\n\n${block}` : block;
}
```

- [ ] **Step 4: Run tests to confirm all pass**

```bash
cd proxy && node --test src/memory.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add proxy/src/memory.js proxy/src/memory.test.js
git commit -m "feat(memory): add appendMemoryBlock helper"
```

---

## Task 4: Wire memory injection into `server.js`

**Files:**
- Modify: `proxy/src/server.js`

- [ ] **Step 1: Update the import from `memory.js`**

Find the existing import at the top of `proxy/src/server.js`:

```js
import { resolveStoreId } from "./memory.js";
```

Replace with:

```js
import { resolveStoreId, memoryRecall, appendMemoryBlock } from "./memory.js";
```

- [ ] **Step 2: Add memory injection after `resumeOrStart`**

In `handleChatCompletions`, find this block (it appears in both streaming and non-streaming paths — there is only one place where `resumeOrStart` is called):

```js
  const { messages: runMessages } = resumeOrStart(body.messages, params.messages);
  params = { ...params, messages: runMessages };
```

Replace with:

```js
  const { messages: runMessages, resumed } = resumeOrStart(body.messages, params.messages);
  params = { ...params, messages: runMessages };

  // Pre-inject long-term memory into the system prompt on fresh conversations,
  // so the agent can greet the user with context without burning a tool round-trip.
  if (!resumed && agentCfg.memory) {
    try {
      const memText = await memoryRecall(agentCfg.memory.anthropic, agentCfg.memory.storeId, "");
      params = { ...params, system: appendMemoryBlock(params.system || "", memText) };
    } catch (err) {
      console.warn(`[proxy] memory injection failed: ${err.message}`);
    }
  }
```

- [ ] **Step 3: Run all proxy tests**

```bash
cd proxy && npm test
```

Expected: all tests pass. (The injection only activates when `agentCfg.memory` is truthy, which is only set in the running server — unit tests don't set it, so there's no live call.)

- [ ] **Step 4: Commit**

```bash
git add proxy/src/server.js
git commit -m "feat(server): pre-inject memory context — skip memory_recall tool on turn 1"
```

---

## Task 5: Heartbeat tuning

**Files:**
- Modify: `proxy/src/server.js`

- [ ] **Step 1: Change the heartbeat threshold**

Find:

```js
const HEARTBEAT_MS = Number.parseInt(process.env.JARVUS_HEARTBEAT_MS || "4500", 10) || 4500;
```

Replace with:

```js
const HEARTBEAT_MS = Number.parseInt(process.env.JARVUS_HEARTBEAT_MS || "1500", 10) || 1500;
```

- [ ] **Step 2: Change the heartbeat check interval**

Find (inside the streaming path of `handleChatCompletions`):

```js
    const heartbeat = setInterval(() => {
```

A few lines up, there is a `setInterval(..., 1000)` call. Change the interval argument from `1000` to `500`:

```js
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity < HEARTBEAT_MS) return;
      fillerIdx = (fillerIdx + 1) % HEARTBEAT_FILLERS.length;
      const lead = agentText && !/\s$/.test(agentText) ? " " : "";
      send(streamChunk({ id, created, model, delta: { content: `${lead}${HEARTBEAT_FILLERS[fillerIdx]} ` } }));
      lastActivity = Date.now();
    }, 500);
```

- [ ] **Step 3: Run all proxy tests**

```bash
cd proxy && npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add proxy/src/server.js
git commit -m "perf(server): heartbeat threshold 4500ms → 1500ms, check interval 1000ms → 500ms"
```

---

## Task 6: Create `preamble.js` with `runWithPreamble`

**Files:**
- Create: `proxy/src/preamble.js`
- Create: `proxy/src/preamble.test.js`

- [ ] **Step 1: Write the failing tests**

Create `proxy/src/preamble.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithPreamble } from "./preamble.js";

test("preamble text arrives before main text", async () => {
  const received = [];
  const preambleProvider = {
    async streamTurn(_params, onText) {
      onText("On it.");
      return { stop_reason: "end_turn", content: [] };
    },
  };
  await runWithPreamble({
    preambleProvider,
    userText: "hello",
    runMain: async (onText) => {
      onText("Hello there!");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["On it.", "Hello there!"]);
});

test("preamble failure does not block main text", async () => {
  const received = [];
  const preambleProvider = {
    async streamTurn() {
      throw new Error("network error");
    },
  };
  await runWithPreamble({
    preambleProvider,
    userText: "hello",
    runMain: async (onText) => {
      onText("Still here!");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["Still here!"]);
});

test("skips preamble when userText is empty", async () => {
  const received = [];
  const preambleProvider = {
    async streamTurn(_p, onText) {
      onText("On it.");
      return {};
    },
  };
  await runWithPreamble({
    preambleProvider,
    userText: "",
    runMain: async (onText) => {
      onText("Response.");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["Response."]);
});

test("skips preamble when preambleProvider is null", async () => {
  const received = [];
  await runWithPreamble({
    preambleProvider: null,
    userText: "hello",
    runMain: async (onText) => {
      onText("Response.");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["Response."]);
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
cd proxy && node --test src/preamble.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` for `./preamble.js`.

- [ ] **Step 3: Create `proxy/src/preamble.js`**

```js
// Decoupled preamble: fires a tiny fast model call to generate a spoken
// acknowledgment while the full agent loop starts simultaneously. Preamble
// text reaches the caller first; main loop text follows after preamble completes.

export const PREAMBLE_SYSTEM =
  "Generate a 3–6 word spoken acknowledgment for a voice assistant. " +
  "Output ONLY those words plus a period. Be natural and varied. " +
  'Examples: "On it." "Let me check that." "Sure, one sec." "Looking that up."';

/**
 * Run preamble and main agent loop concurrently.
 * Preamble text is delivered to onText first; main loop text follows after preamble completes.
 *
 * @param {object}      opts
 * @param {object|null} opts.preambleProvider  provider.streamTurn — null skips preamble
 * @param {string}      opts.userText          spoken user message — empty string skips preamble
 * @param {Function}    opts.runMain           async (onText) => { finishReason, messages, iterations }
 * @param {Function}    opts.onText            (delta: string) => void
 * @returns {Promise<{ finishReason: string, messages: object[], iterations: number }>}
 */
export async function runWithPreamble({ preambleProvider, userText, runMain, onText }) {
  if (!preambleProvider || !userText?.trim()) {
    return runMain(onText);
  }

  const mainBuffer = [];
  let preambleDone = false;

  // Start preamble: streams directly to the caller's onText.
  const preambleTask = preambleProvider
    .streamTurn(
      {
        system: [{ type: "text", text: PREAMBLE_SYSTEM }],
        messages: [{ role: "user", content: userText }],
        max_tokens: 20,
        tools: [],
      },
      (delta) => onText(delta),
    )
    .catch((err) => console.error(`[preamble] failed: ${err.message}`));

  // Start main loop concurrently: buffer its text until preamble completes.
  const mainResultPromise = runMain((delta) => {
    if (preambleDone) onText(delta);
    else mainBuffer.push(delta);
  });

  // Wait for preamble, then flush buffered main text and enable live streaming.
  await preambleTask;
  preambleDone = true;
  for (const d of mainBuffer) onText(d);
  mainBuffer.length = 0;

  return mainResultPromise;
}
```

- [ ] **Step 4: Run tests to confirm all pass**

```bash
cd proxy && node --test src/preamble.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Run all proxy tests together**

```bash
cd proxy && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add proxy/src/preamble.js proxy/src/preamble.test.js
git commit -m "feat(preamble): add runWithPreamble — concurrent preamble + agent loop"
```

---

## Task 7: Wire preamble into `server.js`

**Files:**
- Modify: `proxy/src/server.js`

- [ ] **Step 1: Add preamble imports**

At the top of `proxy/src/server.js`, add two new imports after the existing provider imports:

```js
import { createFireworksProvider } from "./providers/fireworks.js";
import { runWithPreamble } from "./preamble.js";
```

- [ ] **Step 2: Add preamble env vars to the `process.env` destructuring**

Find the destructuring block (the large `const { ... } = process.env;` near the top). Add two lines after `FIREWORKS_FALLBACK_ENABLED`:

```js
  FIREWORKS_PREAMBLE_MODEL = "accounts/fireworks/models/llama-v3p1-8b-instruct",
  JARVUS_PREAMBLE_ENABLED = "true",
```

- [ ] **Step 3: Create `preambleProvider` at module level**

Find the line that creates the main provider:

```js
const provider = createProvider(process.env);
```

Add immediately after it:

```js
const preambleProvider =
  FIREWORKS_API_KEY && JARVUS_PREAMBLE_ENABLED !== "false"
    ? createFireworksProvider({ apiKey: FIREWORKS_API_KEY, model: FIREWORKS_PREAMBLE_MODEL })
    : null;
```

- [ ] **Step 4: Replace `runAgent` with `runWithPreamble` in the streaming path**

Find the inner `try` block of the streaming handler (the one that calls `runAgent`):

```js
    let finishReason;
    let messages;
    try {
      ({ finishReason, messages } = await runAgent({
        provider,
        baseParams: params,
        cfg: agentCfg,
        onText: (delta) => {
          lastActivity = Date.now();
          agentText += delta;
          send(streamChunk({ id, created, model, delta: { content: delta } }));
        },
        onEvent,
      }));
    } finally {
      clearInterval(heartbeat);
    }
```

Replace with:

```js
    let finishReason;
    let messages;
    try {
      ({ finishReason, messages } = await runWithPreamble({
        preambleProvider,
        userText,
        runMain: (onMainText) =>
          runAgent({
            provider,
            baseParams: params,
            cfg: agentCfg,
            onText: (delta) => {
              lastActivity = Date.now();
              onMainText(delta);
            },
            onEvent,
          }),
        onText: (delta) => {
          lastActivity = Date.now();
          agentText += delta;
          send(streamChunk({ id, created, model, delta: { content: delta } }));
        },
      }));
    } finally {
      clearInterval(heartbeat);
    }
```

- [ ] **Step 5: Run all proxy tests**

```bash
cd proxy && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add proxy/src/server.js
git commit -m "feat(server): wire runWithPreamble — guaranteed sub-200ms first spoken word"
```

---

## Task 8: Document new env vars in `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add preamble vars under the Fireworks section**

Find:

```
FIREWORKS_FALLBACK_ENABLED=true
```

Add immediately after it:

```
# Small fast model for the spoken preamble ("On it." in ~150ms).
# Set JARVUS_PREAMBLE_ENABLED=false to disable. Auto-disabled if FIREWORKS_API_KEY is unset.
FIREWORKS_PREAMBLE_MODEL=accounts/fireworks/models/llama-v3p1-8b-instruct
JARVUS_PREAMBLE_ENABLED=true
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document FIREWORKS_PREAMBLE_MODEL and JARVUS_PREAMBLE_ENABLED"
```

---

## Task 9: Smoke test

- [ ] **Step 1: Start the proxy with Fireworks configured**

```bash
cd proxy && npm start
```

Expected log line:
```
[proxy] model=accounts/fireworks/models/llama-v3p3-70b-instruct  fallback=claude-haiku-4-5-20251001  auth=enabled
```

- [ ] **Step 2: Send a streaming request and verify preamble appears first**

```bash
curl -s -N -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep PROXY_API_KEY ../.env | cut -d= -f2)" \
  -d '{"model":"test","stream":true,"messages":[{"role":"user","content":"what is two plus two?"}]}' \
  | grep -o '"content":"[^"]*"' | head -5
```

Expected: first content chunk is a short acknowledgment ("On it." / "Sure." / similar), followed by the actual answer.

- [ ] **Step 3: Verify preamble is skipped when disabled**

```bash
JARVUS_PREAMBLE_ENABLED=false node src/server.js &
sleep 1
curl -s -N -X POST http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep PROXY_API_KEY ../.env | cut -d= -f2)" \
  -d '{"model":"test","stream":true,"messages":[{"role":"user","content":"hello"}]}' \
  | grep -o '"content":"[^"]*"' | head -3
kill %1
```

Expected: no preamble chunk, direct model response.

- [ ] **Step 4: Tag**

```bash
git tag conversation-optimization-verified
```
