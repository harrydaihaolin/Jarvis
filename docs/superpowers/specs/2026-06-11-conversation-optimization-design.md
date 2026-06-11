# Conversation Optimization — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## Goal

Improve conversational smoothness and reduce inference latency across all turn types. Two sequential phases: Phase A fixes the three biggest concrete bottlenecks; Phase C adds a decoupled preamble stream that guarantees near-instant time-to-first-word regardless of model speed.

**Prerequisites:** The Fireworks provider (`2026-06-11-fireworks-provider-design.md`) must be implemented before either phase. Phase C additionally requires `FIREWORKS_API_KEY` to be set.

---

## Phase A — Foundational Fixes

Four targeted changes. No structural rework.

### A1. Fireworks Provider

Execute the existing spec (`2026-06-11-fireworks-provider-design.md`) as written. Provides ~3× faster TTFT and generation speed compared to Claude Sonnet 4.6. All other Phase A changes are independent of which provider is active.

### A2. Parallel Tool Execution

**File:** `proxy/src/agent.js`

**Problem:** The tool-use loop executes tools serially even when multiple tools are independent:
```js
for (const b of toolUses) {
  const out = await executeTool(b.name, b.input, { env, cfg });
}
```
When Claude requests `list_dir` + `read_file` in the same turn, they run sequentially. Each local tool call takes 5–200ms; chained, they add up.

**Fix:** Replace with `Promise.all`. All tools in a turn are dispatched concurrently. Memory tools (`memory_recall`, `memory_read`, `memory_save`) and `show_media` keep their existing inline logic, just parallelised.

`onEvent` emissions are ordered by tool position index (not completion time) so the agent console stays coherent.

**Constraint:** Tools that mutate state (`write_file`, `edit_file`, `run_command`) are already gated on `user_confirmed=true` and typically appear alone in a turn. Parallelising them is safe — each writes to a different path, and the confirmation model means they don't appear together without explicit intent.

### A3. Server-Side Memory Injection

**Files:** `proxy/src/server.js`, `proxy/src/agent.js`

**Problem:** `AGENT_ADDENDUM` instructs Claude to call `memory_recall` at conversation start. This costs one full inference turn (to decide to call the tool) plus the API round-trip — 2–5 seconds before Jarvis can respond.

**New flow:**

1. In `server.js`, before calling `runAgent()`, call `memoryRecall(anthropic, storeId, '')` directly and append the result to the system prompt as a fenced block:
   ```
   <memory>
   {memory content here}
   </memory>
   ```
2. In `agent.js`, remove the instruction *"At the START of a conversation, call memory_recall to remember who you're talking to…"* from `AGENT_ADDENDUM`. This instruction is no longer needed on turn 1.
3. The `memory_recall` tool remains in the tool list. Claude can still query memory mid-conversation for specific lookups ("remind me what we decided about X").

**Failure mode:** If the memory fetch throws, log `[proxy] memory injection failed: <reason>` and proceed with no `<memory>` block. The turn continues normally; Claude will have no injected context but can still call `memory_recall` as a tool if needed.

**Only on first turn:** `resumeOrStart()` returns `resumed: true` for continuation turns (the cached enriched history already contains prior memory context). Memory injection is only applied when `resumed === false`.

### A4. Heartbeat Tuning

**File:** `proxy/src/server.js`

| Setting | Before | After |
|---|---|---|
| `HEARTBEAT_MS` | 4500 ms | 1500 ms |
| Check interval | 1000 ms | 500 ms |

Jarvis now speaks a filler after 1.5 seconds of silence, not 4.5 seconds. The filler text pool (`HEARTBEAT_FILLERS`) is unchanged.

The `JARVUS_HEARTBEAT_MS` env override is preserved — operators can still tune via env if needed.

---

## Phase C — Decoupled Preamble Stream

**Prerequisite:** Phase A complete; `FIREWORKS_API_KEY` set.

### Overview

When a streaming request arrives, two tasks fire concurrently:

1. **Preamble task** — a tiny Fireworks call (small model, `max_tokens=20`, no tools) generating a 3–6 word spoken acknowledgment. Its text chunks are sent to the SSE stream immediately.
2. **Main agent loop** — `runAgent()` starts at the same moment. Its text chunks are buffered in memory while the preamble runs, then flushed and streamed live when the preamble completes.

The user hears *"On it."* within ~100–200ms. By the time the preamble finishes playing, the main loop has been thinking for 100–200ms and typically has its first real tokens ready.

### Text Flow

```
t=0ms   request arrives
t=0ms   preamble inference starts ──→ chunks ──→ send() to SSE immediately
t=0ms   main loop inference starts ──→ chunks ──→ mainBuffer[] (held)
t=~150ms preamble last token sent
         preambleDone = true
         flush mainBuffer → send() to SSE
         main loop continues streaming live
```

### Implementation (streaming path in `server.js`)

```js
const mainBuffer = [];
let preambleDone = false;

// Both start concurrently
const preambleTask = preambleProvider.streamTurn(
  {
    system: [{ type: 'text', text: PREAMBLE_SYSTEM }],
    messages: [{ role: 'user', content: userText }],
    max_tokens: 20,
    tools: [],
  },
  (delta) => {
    agentText += delta;
    send(streamChunk({ id, created, model, delta: { content: delta } }));
    lastActivity = Date.now();
  }
);

const mainTask = runAgent({
  provider,
  baseParams: params,
  cfg: agentCfg,
  env,
  onText: (delta) => {
    lastActivity = Date.now();
    agentText += delta;
    if (preambleDone) send(streamChunk({ id, created, model, delta: { content: delta } }));
    else mainBuffer.push(delta);
  },
  onEvent,
});

// Preamble finishes (~150ms); flush buffer and enable live streaming
await preambleTask;
preambleDone = true;
for (const d of mainBuffer) {
  send(streamChunk({ id, created, model, delta: { content: d } }));
}
mainBuffer.length = 0;

// Await the main loop
const { finishReason, messages } = await mainTask;
```

### Preamble System Prompt

```
Generate a 3–6 word spoken acknowledgment for a voice assistant.
Output ONLY those words plus a period. Be natural and varied.
Examples: "On it." "Let me check that." "Sure, one sec." "Looking that up."
```

### Configuration

Two new env vars added to `.env` and `.env.example`:

| Variable | Default | Purpose |
|---|---|---|
| `FIREWORKS_PREAMBLE_MODEL` | `accounts/fireworks/models/llama-v3p1-8b-instruct` | Fast small model for preamble generation |
| `JARVUS_PREAMBLE_ENABLED` | `true` | Set to `false` to disable; auto-disabled if `FIREWORKS_API_KEY` unset |

`preambleProvider` is created in `server.js` at startup alongside the main provider:
```js
const preambleProvider =
  FIREWORKS_API_KEY && JARVUS_PREAMBLE_ENABLED !== 'false'
    ? createFireworksProvider({ apiKey: FIREWORKS_API_KEY, model: FIREWORKS_PREAMBLE_MODEL })
    : null;
```

When `preambleProvider` is null the streaming path falls back to the Phase A behaviour unchanged.

### Interaction with Existing Systems

**Heartbeat** — unchanged and still necessary. The preamble covers the first 100–200ms of silence; the 1500ms heartbeat (Phase A) covers silence during tool calls.

**speechChunker (frontend)** — no changes. Preamble text ("On it.") ends with a period and is emitted immediately as a sentence. Main loop text follows through the same chunker.

**`agentText` and conversation memory** — preamble text streams first into `agentText`, followed by main loop text. The full string reads naturally: *"On it. The answer is 42."* `rememberTurn` and `cleanSpokenText` see the concatenated result, which is correct.

**Non-streaming path** — preamble is skipped. It applies only to streaming requests (the only path used by the frontend and Tavus).

**Empty `userText`** — if `lastSpokenUserText()` returns an empty string (e.g. a system-only turn), the preamble is skipped for that turn. An empty user message to the preamble model would produce a nonsensical acknowledgment.

### Error Handling

| Failure | Behaviour |
|---|---|
| Preamble throws before any token | Log warning; set `preambleDone = true`; flush main buffer; turn continues normally |
| Preamble throws mid-stream | Same as above; partial preamble text already sent is left in the stream |
| Main loop throws while preamble is still running | Abort preamble; surface error as today |

Preamble errors never crash or stall a turn. The degraded path is current behaviour.

### Files Changed

| File | Change |
|---|---|
| `proxy/src/server.js` | Streaming handler reworked; preamble env vars; `preambleProvider` created |
| `proxy/src/server.test.js` *(new)* | Preamble-before-main chunk ordering; preamble-failure fallback; preamble-disabled fallback |

No changes to `agent.js`, `voiceOutput.ts`, `speechChunker.ts`, or the Kokoro TTS server.

---

## Non-Goals

- Model tiering / routing for complex vs. simple turns (future option)
- Sub-sentence TTS streaming (current chunker is sufficient)
- Context window summarisation
- Parallel inference (speculative decoding)
