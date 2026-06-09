# Jarvus

A real-time **video agent** — not a talking head. A [Tavus CVI](https://docs.tavus.io) replica
(a photorealistic avatar that sees, hears, and speaks, with built-in STT / TTS / turn-taking) is
the face and voice; **Claude is the brain, and it actually does work**: researches the web, reads
and writes files in a sandboxed workspace, and (optionally) runs commands — asking for confirmation
before anything that changes state.

The key trick: Tavus never runs tools itself. By making Claude Tavus's "custom LLM", **the proxy
*is* the LLM**, so it runs Claude's full tool-use loop server-side and streams back only the spoken
result. Tavus just sees a very smart streaming model.

```
Browser (cam+mic) ──WebRTC──► Tavus CVI ──► perception · turn-taking · STT
   ▲                              │                                  │
   │  replica video + voice ◄─── TTS ◄─── LLM layer ◄────────────────┘
   │                                         │  OpenAI-compatible, streaming (SSE)
frontend/ (React + @tavus/cvi-ui)            ▼
                              proxy/ = AGENT RUNTIME
                              Claude tool-use loop ──► web_search (Anthropic server tool)
                                                  ├──► files: read/write/edit/search (sandboxed)
                                                  └──► run_command (opt-in, confirmed)
```

| Path | What it does |
|------|--------------|
| `proxy/` | **Agent runtime**: runs Claude's tool-use loop (web/files/commands) and exposes it as an OpenAI-compatible streaming endpoint. Holds `ANTHROPIC_API_KEY`. |
| `lib/tavus.mjs` | Shared server-side Tavus client (persona + conversation create/end). |
| `scripts/setup-tavus.mjs` | CLI to create the persona + a conversation and print the `conversation_url`. |
| `frontend/` | React + `@tavus/cvi-ui` video UI + a tiny dev backend (`server.mjs`) that creates conversations server-side. |
| `docs/tavus/` | **Vendored authoritative Tavus references** — `skill.md`, `openapi.yaml`, `llms.txt`. |
| `docker-compose.yml` | Runs the proxy + an ngrok tunnel (so Tavus can reach the proxy). |

## Two ways to use Claude

- **Option A — Tavus-hosted Claude** (simplest): set `USE_TAVUS_HOSTED_LLM=true` in `.env`. Tavus
  runs `tavus-claude-haiku-4.5` for you — no proxy, no tunnel. Billed by Tavus, fixed model. Skip
  straight to [Frontend](#4-frontend).
- **Option B — Custom proxy** (this repo's default): your own Anthropic key and any model (Opus 4.8,
  Sonnet 4.6), full control of the prompt/tools/context. Requires the publicly reachable proxy below.

## Prerequisites

- **Node 22+** and **npm** (a clean `npm install` is verified on Node 22.4.1).
- **Docker** (for the proxy + ngrok tunnel in Option B).
- An **Anthropic API key** — https://console.anthropic.com/settings/keys
- A **Tavus API key** — https://platform.tavus.io/api-keys (free plan: 25 conversation minutes + stock replicas)
- An **ngrok authtoken** (Option B only) — https://dashboard.ngrok.com/get-started/your-authtoken
- **Rust** + Xcode Command Line Tools — only for the optional [desktop app](#5-desktop-app-tauri--optional).

## Setup

### 1. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:
- `ANTHROPIC_API_KEY` and pick `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`).
- `TAVUS_API_KEY` (keep `TAVUS_TEST_MODE=true` while developing — **no minutes are billed**).
- `PROXY_API_KEY` — any random string; it's the shared secret between Tavus and the proxy.
- `NGROK_AUTHTOKEN` (Option B).
- Customize `PERSONA_SYSTEM_PROMPT` / `PERSONA_GREETING` to taste.

> 🔒 **Never** put `TAVUS_API_KEY` or `ANTHROPIC_API_KEY` in browser code. All key use is server-side.

### 2. Start the Claude proxy + tunnel (Option B)

**With Docker (Linux / macOS 13+ / Windows):**
```bash
docker compose up --build
```

**Without Docker (recommended on macOS 12, where current Docker Desktop won't install):**
```bash
# terminal 1 — the agent proxy
cd proxy && npm install && npm run dev            # http://localhost:8787

# terminal 2 — free public tunnel (Cloudflare; no account/token needed)
npm run tunnel                                    # = node scripts/tunnel.mjs
```

`npm run tunnel` starts a **Cloudflare quick tunnel** (`cloudflared`), grabs the public
`https://<random>.trycloudflare.com` URL, and writes `PUBLIC_PROXY_BASE_URL=<url>/v1` into `.env`
automatically — so the setup script, web backend, and desktop app all use it with no copy-paste.
Leave it running; Ctrl-C closes the tunnel.

Install `cloudflared` once if needed:
`curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz | tar xz && sudo mv cloudflared /usr/local/bin/`

> **Tunnel options:** `npm run tunnel` (Cloudflare, free, no signup) · ngrok (free tier, needs an
> authtoken; auto-detected from `http://localhost:4040`) · or deploy the proxy to a host for a
> permanent URL. Any of them just needs to set `PUBLIC_PROXY_BASE_URL` (the Cloudflare script does it
> for you). `npm run tunnel:docker` runs the old proxy+ngrok compose stack (needs Docker).

### 3. (Optional) Create a persona + conversation from the CLI

```bash
node scripts/setup-tavus.mjs           # prints a conversation_url you can open directly
node scripts/setup-tavus.mjs --dry-run # print the exact API payloads without calling Tavus
```

This is optional — the frontend creates conversations on demand. It's handy for verifying the wiring.

### 4. Frontend

```bash
cd frontend
npm install
npm run dev:all      # runs the dev backend (:8788) + Vite (:5173) together
```

Open **http://localhost:5173** and click **Start conversation**. The dev backend creates a Tavus
conversation server-side (reusing a persona it creates on first run) and the cvi-ui `<Conversation>`
component joins the live WebRTC call.

### 5. Desktop app (Tauri) — optional

The same React UI ships as a native desktop app (`frontend/src-tauri/`, Rust). In desktop mode the
`TAVUS_API_KEY` lives in **Rust commands** (`create_conversation` / `end_conversation`) instead of
the Node dev backend — `src/api.ts` auto-detects Tauri and calls `invoke()` vs `fetch('/api/...')`.

Prereqs: **Rust** (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`) and Xcode
Command Line Tools. Then:

```bash
cd frontend
npm install
npm run tauri:dev      # launches the desktop window (runs `npm run dev` for you)
npm run tauri:build    # produces a .app / .dmg in src-tauri/target/release/bundle
```

The proxy + ngrok are **still required** and run exactly as in the web flow — Tavus's servers reach
the agent brain at the public proxy URL; the desktop app is just the client. Config is read from the
repo-root `.env`.

**macOS camera/microphone:** the app's `Info.plist` (`src-tauri/Info.plist`) declares
`NSCameraUsageDescription` + `NSMicrophoneUsageDescription` so macOS will prompt for access inside
the WKWebView. `getUserMedia` in WKWebView is supported on macOS 12+ but the permission prompt can be
finicky in dev; if the camera doesn't light up, see Troubleshooting.

## What the agent can do

The proxy gives Claude a tool set and runs the full tool-use loop server-side (`proxy/src/agent.js`,
`proxy/src/tools/`):

| Tool | Type | Risk | Notes |
|------|------|------|-------|
| `web_search` | Anthropic **server tool** | read-only | Real-time web research with citations. Enable "Web search" for your org in the Anthropic Console. |
| `list_dir`, `read_file`, `search_files` | local | read-only | Auto-execute. |
| `write_file`, `edit_file` | local | **mutating** | Require spoken confirmation (`user_confirmed=true`). |
| `run_command` | local | **mutating** | Shell access, **off by default** (`AGENT_ENABLE_COMMANDS`). Confirmed + denylisted + workspace-cwd. |
| `show_media` | local | display | Pushes an image/video/link to the **Agent Console** panel (doesn't speak it). |

### Agent console (side panel)

The video/voice path (Tavus) only carries speech, so the agent's transcript, tool activity,
citations, and media surface through a **separate channel**: the proxy broadcasts structured events
on `GET /events` (SSE), and the app subscribes directly (`src/agentEvents.ts` → `AgentConsole.tsx`,
shown beside the video during a call). Point it at a non-default proxy with `VITE_PROXY_URL`.

**Confirm-before-acting** is enforced two ways: (1) the system prompt tells the agent to state the
action and wait for a spoken "yes"; (2) every mutating tool *requires* `user_confirmed=true` or it
refuses and asks. **Everything is sandboxed to `AGENT_WORKSPACE`** (default `./workspace`) — paths
that escape it (absolute, `../`, symlinks) are rejected, and mutating actions are logged to
`workspace/.agent-audit.log`.

> ⚠️ `run_command` executes shell commands. Leave `AGENT_ENABLE_COMMANDS=false` unless you want that,
> and remember the sandbox bounds *where* it runs, not *what a confirmed command can do*.

## How the Claude connection works

1. The setup script / frontend backend creates a Tavus **persona** whose `layers.llm` points at the
   proxy: `{ model, base_url: "https://<tunnel>/v1", api_key: PROXY_API_KEY, speculative_inference: true }`.
2. During a conversation, Tavus transcribes the user and POSTs an OpenAI-style request to
   `<base_url>/chat/completions` (streaming), sending `Authorization: Bearer <PROXY_API_KEY>`.
3. `proxy/src/translate.js` maps it to Anthropic Messages; `agent.js` runs the **tool-use loop**
   (call Claude → execute any tool calls → feed results back → repeat) and streams the final spoken
   text out as OpenAI SSE. Tool round-trips are invisible to Tavus — it just hears the answer.

Switch models any time via `ANTHROPIC_MODEL` in `.env` (Sonnet 4.6 for snappy turns, Opus 4.8 for the
hardest tasks). The agent loop needs **Anthropic API credits** to run live — there's no Tavus-hosted
equivalent, since the tools execute in *our* proxy.

## Authoritative Tavus guidance (not just ad-hoc docs)

This repo is pinned to Tavus's own machine-readable guidance so we don't invent endpoints:

- **`docs/tavus/skill.md`** — Tavus's official Agent Skill: workflow, decision tables, gotchas, checklist.
- **`docs/tavus/openapi.yaml`** — the authoritative HTTP API contract.
- **`docs/tavus/llms.txt`** — index of all Tavus doc pages.
- **Tavus docs MCP** — configured in `.mcp.json` (`tavus-docs` → `https://docs.tavus.io/mcp`) for
  *live* doc retrieval. It's project-scoped, so **approve it once**: run `claude` interactively and
  accept the `tavus-docs` server when prompted. (Read-only docs retrieval; it performs no API actions.)

Refresh the vendored copies any time:
```bash
curl -fsSL https://docs.tavus.io/skill.md    -o docs/tavus/skill.md
curl -fsSL https://docs.tavus.io/openapi.yaml -o docs/tavus/openapi.yaml
curl -fsSL https://docs.tavus.io/llms.txt     -o docs/tavus/llms.txt
```

See **`AGENTS.md`** for the condensed rules (key handling, custom-LLM constraints, billing).

## Billing & cleanup

- Conversations **start billing the moment they're created** (the replica joins the room). Keep
  `TAVUS_TEST_MODE=true` while developing.
- The frontend ends the conversation when you click leave. To end one manually:
  ```bash
  curl -X POST https://tavusapi.com/v2/conversations/<id>/end -H "x-api-key: $TAVUS_API_KEY"
  ```

## Testing

```bash
npm run proxy:test        # unit tests for the OpenAI↔Anthropic translation
npm run setup:dry         # render the Tavus API payloads without any network calls
cd frontend && npm run build   # type-check + production build
```

## Troubleshooting

- **Frontend build can't find `@rolldown/binding-darwin-x64`** — Vite 8's native binding is pinned in
  `frontend/package.json` to dodge [npm/cli#4828](https://github.com/npm/cli/issues/4828). On a
  non-macOS/x64 host, swap it for your platform's binding (e.g. `@rolldown/binding-linux-x64-gnu`).
- **Setup script: "Could not determine the proxy's public URL"** — the ngrok tunnel isn't up. Start
  `docker compose up`, or set `PUBLIC_PROXY_BASE_URL` in `.env`.
- **Tavus calls the proxy but gets 401** — `PROXY_API_KEY` in `.env` must match what the persona was
  created with. Recreate the persona (delete `TAVUS_PERSONA_ID` / restart the backend) after changing it.
- **Replica connects but never responds** — check the proxy logs; a bad `ANTHROPIC_API_KEY` shows up
  there as a 401 from Anthropic.
- **`web_search` errors** — enable "Web search" for your org in the Anthropic Console (Settings → Privacy).
- **Desktop: camera/mic stays black / no permission prompt** — a known WKWebView quirk. Workarounds:
  (1) build the bundle (`npm run tauri:build`) and run the packaged `.app` rather than `tauri:dev`, so
  the merged `Info.plist` usage strings apply; (2) grant access once by opening `http://localhost:5173`
  in **Safari** and allowing camera/mic, then relaunch the app; (3) check System Settings → Privacy &
  Security → Camera/Microphone for "Jarvus". Confirm the same conversation works in a browser
  first to isolate app-permission issues from Tavus/proxy issues.
