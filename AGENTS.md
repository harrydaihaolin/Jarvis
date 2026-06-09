# tavus-agent — Agent & Contributor Guide

A real-time **conversational video agent**: a Tavus CVI replica (video avatar + STT/TTS +
turn-taking) whose "brain" is the **Anthropic Claude API**, wired in through a custom
OpenAI-compatible LLM proxy.

## Source of truth

Tavus behavior is governed by the **official Tavus Agent Skill and OpenAPI spec vendored in
`docs/tavus/`** — do not invent endpoints or field names:

- `docs/tavus/skill.md` — Tavus's own capability guide, workflow, and gotchas. **Read this first.**
- `docs/tavus/openapi.yaml` — authoritative HTTP API contract (`https://tavusapi.com/v2/`).
- `docs/tavus/llms.txt` — index of all Tavus doc pages for deeper lookups.

For *live* lookups against current Tavus docs, the official **Tavus docs MCP** is configured in
`.mcp.json` (`tavus-docs` → `https://docs.tavus.io/mcp`). It is project-scoped, so it must be
**approved once** in an interactive `claude` session before its tools are callable. The MCP does
read-only doc retrieval; it does not perform API actions.

## Architecture

```
Browser (camera+mic)
   │  WebRTC (Daily)
   ▼
Tavus CVI  ──► Perception (raven) ─► Turn-taking (sparrow) ─► STT
   │                                                            │
   │   replica video (Phoenix) ◄── TTS ◄── LLM layer ──────────┘
   │                                         │  (custom, OpenAI-compatible, SSE)
   │                                         ▼
   │                              proxy/  /v1/chat/completions
   │                                         │  Anthropic Messages API
   │                                         ▼
   │                                   Claude (your ANTHROPIC_API_KEY)
   ▼
frontend/  React + @tavus/cvi-ui  — creates the conversation, renders the call
```

- **`proxy/`** — the **agent runtime**, exposed as an OpenAI-compatible streaming endpoint so Claude
  is usable as a Tavus "custom LLM". Tavus's servers call it, so it must be **publicly reachable**
  (ngrok in dev). Holds `ANTHROPIC_API_KEY`.
  - `src/translate.js` — OpenAI ↔ Anthropic message mapping (system hoisting, role merge, leading-user).
  - `src/agent.js` — runs **Claude's tool-use loop** (call → execute tools → feed results → repeat),
    streams only the final spoken text. Handles `tool_use` and server-tool `pause_turn`. Iteration cap.
  - `src/tools/index.js` — tool defs + executors; `src/tools/sandbox.js` — workspace + command guard.
- **`scripts/setup-tavus.mjs`** — creates the persona (pointing `layers.llm.base_url` at the
  proxy's public URL) and a conversation; prints the `conversation_url`. Auto-detects the ngrok URL.
- **`frontend/`** — React + `@tavus/cvi-ui`; renders the live video conversation. `src/api.ts`
  abstracts conversation create/end: Tauri `invoke()` on desktop, `fetch('/api/...')` on web.
- **`frontend/src-tauri/`** — optional **Tauri v2 desktop app** (Rust). `src/tavus.rs` ports the
  conversation create/end logic so `TAVUS_API_KEY` stays in Rust; `Info.plist` carries the macOS
  camera/mic usage strings. The proxy + ngrok are still required (the app is just the client).

## Agent tools & safety

- Tools: `web_search` (Anthropic **server** tool — no executor, needs Console opt-in), read-only
  `list_dir`/`read_file`/`search_files`, and mutating `write_file`/`edit_file`/`run_command`.
- **Confirm-before-acting**: mutating tools require `user_confirmed=true` (the executor refuses
  otherwise) *and* the system addendum makes the agent ask out loud first. Don't weaken this.
- **Sandbox**: every path goes through `resolveInWorkspace()` and stays under `AGENT_WORKSPACE`;
  `run_command` is opt-in (`AGENT_ENABLE_COMMANDS`), denylisted, and run with cwd = workspace.
- Mutating actions append to `workspace/.agent-audit.log`. The agent loop needs Anthropic credits to
  run live (no Tavus-hosted equivalent — tools execute in our proxy).

## Two ways to "use Claude" (decided: Option B)

- **Option A — Tavus-hosted Claude:** set `layers.llm.model = "tavus-claude-haiku-4.5"` and omit
  `base_url`/`api_key`. No proxy needed. **Chat only — cannot run our server-side tools**, so the
  agent capabilities below are unavailable in this mode. Toggle via `USE_TAVUS_HOSTED_LLM=true`.
- **Option B — Custom proxy (required for the agent):** your Anthropic key + any model (Opus 4.8,
  Sonnet 4.6), full control of prompt/tools/context. The proxy runs the tool-use loop.

## Hard rules (from skill.md "Common Gotchas" + "Verification Checklist")

- **Never put `TAVUS_API_KEY` or `ANTHROPIC_API_KEY` in client/browser code.** Keys are server-side
  only. The frontend gets a `conversation_url` from a backend route, never the raw key.
- Tavus auth header is **`x-api-key`** (not `Authorization`). The proxy, being OpenAI-compatible,
  receives `Authorization: Bearer <key>` from Tavus.
- Custom LLM endpoint **must stream (SSE)** and be OpenAI-compatible. `base_url` must **not** include
  the `/chat/completions` route extension (Tavus appends it). Use `.../v1`.
- Conversations **start billing when created** (replica joins the room). Use `test_mode: true` to
  validate without billing, and always call `POST /v2/conversations/{id}/end` when done.
- Keep the system prompt under ~5,000 tokens for latency/quality.
- `speculative_inference` defaults to `true` — keep it on for responsiveness.

## Common commands

```bash
# 1. Proxy (Claude brain) — local
cd proxy && npm install && npm run dev          # http://localhost:8787

# Or dockerized + ngrok tunnel (proxy must be public for Tavus to reach it)
docker compose up --build                       # proxy:8787 + ngrok (UI on :4040)

# 2. Create persona + conversation (auto-detects ngrok public URL)
node scripts/setup-tavus.mjs                     # prints conversation_url

# 3. Frontend
cd frontend && npm install && npm run dev        # http://localhost:5173
```

Environment is configured via the root `.env` (copy from `.env.example`). The proxy, setup script,
and frontend each read the variables they need.
