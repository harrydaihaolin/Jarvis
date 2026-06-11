# Fireworks AI Provider — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## Goal

Make the Jarvis proxy model-agnostic: Fireworks AI as the primary LLM, Claude (Anthropic) as automatic fallback. No changes to the agent tool loop, heartbeat pacing, Notion MCP, or the translate layer.

---

## Architecture

A `providers/` directory is added under `proxy/src/`. All LLM call sites in `agent.js` and `server.js` route through a single provider interface instead of calling the Anthropic SDK directly.

```
proxy/src/
  providers/
    fireworks.js   — OpenAI-compat HTTP client; normalises Fireworks SSE → Anthropic event shape
    anthropic.js   — extracted from current agent.js / server.js; behaviour unchanged
    index.js       — selects provider, wraps fallback logic
  agent.js         — calls provider instead of Anthropic SDK directly (minimal diff)
  server.js        — reads FIREWORKS_API_KEY from env (no other changes)
```

**Provider interface** — one method:

```js
streamChatCompletion(messages, tools, cfg) → AsyncIterable<AnthropicStreamEvent>
```

The iterable emits events in Anthropic's format (`content_block_delta`, `tool_use`, `message_stop`, etc.). Everything downstream of this call — heartbeat, tool dispatch, Notion MCP, SSE broadcast — is untouched.

---

## Configuration

New env vars (added to `.env` and `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `FIREWORKS_API_KEY` | _(unset)_ | Fireworks API key. If unset, proxy behaves exactly as today (Claude only). |
| `FIREWORKS_MODEL` | `accounts/fireworks/models/llama-v3p3-70b-instruct` | Primary model. |
| `FIREWORKS_FALLBACK_ENABLED` | `true` | Set to `false` to hard-error on Fireworks failure instead of falling back. |

`ANTHROPIC_MODEL` continues to control the fallback (Claude) model.

**Provider selection rule:**
- `FIREWORKS_API_KEY` set → Fireworks primary, Claude fallback (if `FIREWORKS_FALLBACK_ENABLED=true`)
- `FIREWORKS_API_KEY` unset → Claude only (existing behaviour, zero breaking change)

**Fireworks endpoint:** `https://api.fireworks.ai/inference/v1/chat/completions`

The proxy already builds OpenAI-format messages; the Fireworks chat completions endpoint is OpenAI-compatible, so no message-format translation is required. Tool definitions (`tools` array) are passed through unchanged.

---

## Streaming Normalisation

Fireworks streams OpenAI SSE (`delta.content`, `delta.tool_calls`). The rest of the proxy expects Anthropic SSE (`content_block_delta`, `tool_use`). `fireworks.js` normalises the stream:

| Fireworks event | Anthropic equivalent |
|---|---|
| `delta.content` text chunk | `content_block_delta` / `text_delta` |
| `delta.tool_calls` chunk | `content_block_delta` / `input_json_delta` + `tool_use` start |
| `finish_reason: stop` | `message_stop` |
| `finish_reason: tool_calls` | `message_delta` with `stop_reason: tool_use` |

The `anthropic.js` provider is the current Anthropic SDK call extracted verbatim — no behaviour change.

---

## Error Handling & Fallback

Fallback to Claude triggers on:
- HTTP 4xx / 5xx from Fireworks
- Network error or stream timeout (30 s hard limit, matching `COMMAND_TIMEOUT_MS`)
- Malformed / unparseable SSE chunk

Fallback does **not** trigger on:
- Tool execution errors (returned to the model as `tool_result`, same as today)
- Model refusals (valid response, not a provider error)

On fallback: logs `[provider] Fireworks failed (<reason>), falling back to Claude` to stderr. The turn continues with Claude — no audible gap for the user. No Fireworks retry (retry on a failing provider adds latency without benefit).

When `FIREWORKS_FALLBACK_ENABLED=false`, Fireworks errors propagate as HTTP 502 to the caller.

---

## Testing

New test files (all unit, no live network):

- `proxy/src/providers/fireworks.test.js` — SSE → Anthropic event normalisation (pure function)
- `proxy/src/providers/anthropic.test.js` — smoke test confirming extracted provider matches current behaviour
- `proxy/src/providers/index.test.js` — fallback logic: mock throws on first call, asserts second call (Claude) succeeds

Existing tests (`agent.test.js`, `conversation.test.js`, `translate.test.js`) are unchanged.

---

## Non-Goals

- Fireworks Responses API / native MCP (future option, not in scope)
- Per-turn provider selection
- Load balancing across providers
- Retry on Fireworks before falling back
