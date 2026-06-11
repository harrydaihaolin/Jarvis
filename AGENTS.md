# Jarvis — Agent & Contributor Guide

**Jarvis** is a desktop AI agent with an animated face. **Claude is the brain** — it researches
the web, reads and writes files in a sandboxed workspace, and runs commands with your confirmation.
An animated robotic face with eye tracking is the interface: say **"Hey Jarvis"** to wake it,
talk or type, and hear it speak back in a natural local neural voice.

## Architecture

```
[Camera] → [Swift STT sidecar / Wake word] → Tauri "transcript" / "wake-word" event → TextInput
[Camera] → [Swift Eye-Tracker sidecar]      → Tauri "face-position" event            → JarvisFace eyes
[TextInput] → POST /v1/chat/completions     → [Local Proxy :8787]                    → Fireworks (primary) / Claude (fallback)
[Kokoro TTS :8788]                          → audio output                            → JarvisFace emotion
[Proxy SSE /events]                         → EventSource                             → AgentConsole
```

No public tunnel required — everything runs on localhost.

## Codebase layout

| Path | What it does |
|------|--------------|
| `proxy/` | **Agent runtime** — Claude's tool-use loop, OpenAI-compatible streaming endpoint. Holds `ANTHROPIC_API_KEY`. |
| `proxy/src/translate.js` | OpenAI ↔ Anthropic message mapping (system hoisting, role merge, leading-user). |
| `proxy/src/agent.js` | Runs the Claude tool-use loop; streams spoken text via `onText()`. |
| `proxy/src/conversation.js` | Per-turn working memory so tool results survive across turns. |
| `proxy/src/providers/` | Provider layer — Fireworks-primary, Claude fallback (`streamTurn`). |
| `proxy/src/preamble.js` | Concurrent spoken acknowledgment (~150 ms) while the agent loop starts. |
| `proxy/src/tools/` | Tool defs + executors; `sandbox.js` — workspace + command guard. |
| `tts/` | Local Kokoro-82M neural TTS server (`server.py`). Run with `./tts/start.sh`. |
| `frontend/` | React + Tauri desktop app: animated face, voice I/O, agent console. |
| `frontend/src/components/JarvisFace.tsx` | Animated SVG/CSS face — emotions, blink, speaking ring, eye tracking. |
| `frontend/src/voiceOutput.ts` | Kokoro TTS client (falls back to Web SpeechSynthesis). |
| `frontend/src/chatSession.ts` | Streams messages to the proxy; maintains rolling conversation history. |
| `frontend/src/AgentConsole.tsx` | Live transcript, tool activity, citations, media via proxy SSE `/events`. |
| `frontend/src-tauri/` | Rust: wake word (Picovoice), STT sidecar (macOS Speech), tray, window. |

## Agent tools & safety

- **`web_search`** — Anthropic server tool (no executor; needs Console opt-in). Only runs on Claude turns — Fireworks-primary turns have no live web search.
- **Read-only** (`list_dir`, `read_file`, `search_files`) — auto-execute.
- **Mutating** (`write_file`, `edit_file`, `run_command`) — require `user_confirmed: true`; audited.
- **Sandbox**: every path goes through `resolveInWorkspace()` and stays under `AGENT_WORKSPACE`.
- `run_command` is opt-in via `AGENT_ENABLE_COMMANDS=true`, deny-listed, and workspace-cwd.
- Mutating actions append to `workspace/.agent-audit.log`.

## Notion notes

When the user says "take notes in Notion", "save this to Notion", "log this", or similar:
1. Compose a page title: `YYYY-MM-DD — <topic>` where topic is inferred from the conversation.
2. Assemble page body from the session: key findings, summaries, citations as text blocks,
   and any images shown via show_media as external image blocks (URL only, no base64).
3. Call notion `create_page` with parent={database_id: NOTION_DATABASE_ID}, properties for
   Name/Date/Topic, and children blocks for the body.
4. Confirm verbally: "Done — I've saved the notes to Notion."

When the user says "read notes from Notion", "look up [X] in Notion", or "find my notes on [X]":
1. Call notion `query_database` with a filter on Topic or a text search on Name.
2. For the matching entry, call notion `retrieve_block_children` to get the page body.
3. Summarise the content into the conversation.

The Notion MCP server is configured in `.mcp.json` (`notion` → `@notionhq/notion-mcp-server`,
reads `NOTION_TOKEN`). It must be **approved once** in an interactive session. The **Jarvis Notes**
database lives under the user's "Jarvis" Notion page; its id is in `NOTION_DATABASE_ID`.
Schema: `Name` (Title, `YYYY-MM-DD — <topic>`), `Date` (Date, today), `Topic` (Select).

## Hard rules

- **Never put `ANTHROPIC_API_KEY` in client/browser code.** It is server-side only (proxy).
- The proxy auth header is `Authorization: Bearer <PROXY_API_KEY>` (OpenAI convention).
- Keep the agent system prompt under ~5,000 tokens for latency/quality.

## CI and the feedback loop

After you push or update a PR, monitor CI check results (`.github/workflows/ci.yml`). Treat
failing checks as signal to act on. When CI fails, read the logs, fix the root cause, and push
follow-up commits. Do not declare the task done while checks are red.

Verify CI status with: `gh pr checks` or the Actions tab on the PR.

## Common commands

```bash
# 1. Proxy (Claude brain)
cd proxy && npm start                          # http://localhost:8787

# 2. Kokoro TTS (local voice)
./tts/start.sh                                 # http://localhost:8788  (run setup.sh once first)

# 3. Desktop app
cd frontend
set -a && . ../.env && set +a
PATH="$HOME/.cargo/bin:$PATH" npm run tauri:dev:voice   # voice input + STT
# or: tauri:dev (face only) · tauri:dev:wake (+ wake word) · tauri:dev:full (+ eye tracking)

# Tests
cd frontend && npm test                        # vitest — voiceOutput, chatSession, speechChunker, bargeIn
cd proxy && npm test                           # node --test — translate, agent, conversation
```

Environment is configured via the root `.env` (copy from `.env.example`).
