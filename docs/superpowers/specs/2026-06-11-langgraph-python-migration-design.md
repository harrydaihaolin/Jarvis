# LangGraph Python Migration — Design Spec

**Date:** 2026-06-11
**Status:** Approved

## Goal

Replace the Node.js `proxy/` service with a Python FastAPI + LangGraph service (`agent/`). LangGraph provides a supervisor-pattern orchestration graph with four domain subgraph agents (Finance, News, Email, Notion) plus the existing Workspace agent. MCP servers (Notion, Gmail, Outlook) are wired via `langchain-mcp-adapters` — tool schemas are auto-discovered, eliminating hand-written definitions. The Tauri frontend and TTS server are untouched; they continue speaking to `localhost:8787` with the same OpenAI-compatible SSE format.

---

## Architecture

```
Tauri frontend  →  agent/ FastAPI (port 8787)  →  LangGraph supervisor graph
                                                         ↓
                              ┌──────────────────────────────────────────────┐
                              │  finance_agent   yfinance + AV + CoinGecko   │
                              │  news_agent      Anthropic web_search         │
                              │  email_agent     Gmail MCP + Outlook MCP      │
                              │  notion_agent    Notion MCP                   │
                              │  workspace_agent list_dir / read / write / …  │
                              └──────────────────────────────────────────────┘
```

`proxy/` stays in the repo but goes dormant as a fallback during the migration period.

---

## LangGraph Graph Structure

### State

```python
class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    session_images: list    # URLs from show_media calls this turn
    memory_context: str     # injected on turn 1 from Anthropic Memory Store
    thread_id: str          # LangGraph checkpointer key
```

### Supervisor

- Model: Fireworks primary / Claude Sonnet fallback (same provider logic as today)
- Each domain subgraph is exposed to the supervisor as a callable tool (`call_finance_agent(query: str)`, etc.)
- Supervisor decides which domain tools to call; can call multiple concurrently (LangGraph handles parallel subgraph execution)
- Synthesizes domain results into the final spoken reply

### Domain subgraphs

Each is a `create_react_agent` ReAct loop with its own tool set. Uses a faster/cheaper model (Haiku or Fireworks Llama-3-8b) — narrower job, less reasoning required.

### Checkpointing

`langgraph-checkpoint-sqlite` with a file at `~/.jarvis/checkpoints.db`. `thread_id` is derived from the conversation ID the frontend sends. Replaces `conversation.js` / `resumeOrStart()` — same resumption behaviour with no hand-rolled state machine.

---

## Domain Nodes

### Finance node (`graph/nodes/finance.py`)

| Tool | Source | Returns |
|---|---|---|
| `get_quote(symbol)` | yfinance | Price, change %, volume, market cap |
| `get_history(symbol, period)` | yfinance | OHLCV CSV (1d / 5d / 1mo / etc.) |
| `get_fundamentals(symbol)` | Alpha Vantage | P/E, EPS, revenue, earnings dates |
| `get_crypto(coin_id)` | CoinGecko | Price, 24h change, market cap, rank |

`ALPHA_VANTAGE_API_KEY` required. `COINGECKO_API_KEY` optional (free tier works without it). yfinance needs no key.

### News node (`graph/nodes/news.py`)

Thin ReAct agent wrapping Anthropic's `web_search` server tool. No new API key. The web_search server tool only fires when the Anthropic model is active — same constraint as today, enforced in the provider layer.

### Email node (`graph/nodes/email.py`)

Gmail and Outlook MCP servers started as subprocesses at service startup. Tools auto-discovered via `langchain-mcp-adapters`:

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "gmail":   {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-gmail"]},
    "outlook": {"command": "npx", "args": ["-y", "@microsoft365/mcp-server"]},
})
email_tools = await client.get_tools()
```

Auth via `GMAIL_TOKEN` and `OUTLOOK_TOKEN` env vars. Send/reply tools require `user_confirmed=true` (same mutating gate as workspace tools).

### Notion node (`graph/nodes/notion.py`)

Notion MCP server started via `langchain-mcp-adapters`, replacing the current `.mcp.json`:

```python
"notion": {
    "command": "npx",
    "args": ["-y", "@notionhq/notion-mcp-server"],
    "env": {"NOTION_TOKEN": "..."}
}
```

Tools auto-discovered. `AGENT_NOTION_READONLY` flag preserved — if set, the subgraph system prompt restricts to read-only tools.

### Workspace node (`graph/nodes/workspace.py`)

Direct port of `tools/index.js` to Python. Same tools (`list_dir`, `read_file`, `search_files`, `write_file`, `edit_file`, `run_command`), same sandbox path resolution, same confirmation gate on mutating tools, same audit log at `workspace/.agent-audit.log`.

---

## Infrastructure

### FastAPI server (`server.py`)

Direct port of `server.js`. Same routes (`/v1/chat/completions`, `/events`, `/health`, `/v1/models`), same auth middleware (`PROXY_API_KEY`), same env vars. Uvicorn on port 8787.

### Streaming (`streaming.py`)

LangGraph's `astream_events` emits graph events. A translation layer converts to OpenAI SSE chunks:

```
on_llm_stream   →  data: {"choices":[{"delta":{"content":"..."}}]}
on_tool_start   →  broadcast to /events (tool_call event)
on_tool_end     →  broadcast to /events (tool_result event)
```

Frontend receives identical SSE — zero Tauri changes required.

### Heartbeat

`asyncio` background task fires every 500ms. Resets on each `on_llm_stream` event. Same filler strings as today. Filler text is not added to the checkpointed message history.

### Preamble (`preamble.py`)

Runs before the LangGraph graph starts. Direct Fireworks call (low reasoning effort) streams fast first words. Main graph runs concurrently; its output follows the preamble seamlessly. Implemented as two concurrent coroutines with an `asyncio.Event` handoff.

### Memory (`memory.py`)

Port of `memory.js` using the Anthropic Python SDK. On fresh conversation (`thread_id` not found in checkpointer), memory is fetched from the Anthropic Memory Store and prepended to the supervisor system prompt as a `<memory>` block. `memory_save` / `memory_recall` / `memory_read` remain available as supervisor tools for mid-conversation use.

### Provider layer (`providers/`)

- `fireworks.py` — `langchain-openai`'s `ChatOpenAI` pointed at `https://api.fireworks.ai/inference/v1`
- `anthropic.py` — `langchain-anthropic`'s `ChatAnthropic`
- `index.py` — selects Fireworks if `FIREWORKS_API_KEY` is set, Claude otherwise; retries on Fireworks 5xx and falls back to Claude

### SSE `/events` console feed (`events.py`)

Port of `events.js`. One `asyncio.Queue` per connected client; `broadcast()` pushes to all queues; the `/events` SSE endpoint drains them. Tool calls, citations, memory ops, media, transcripts all flow through identically to today.

---

## Directory Layout

```
agent/
  pyproject.toml
  .python-version               # 3.12
  src/
    server.py
    graph/
      supervisor.py
      nodes/
        finance.py
        news.py
        email.py
        notion.py
        workspace.py
    providers/
      fireworks.py
      anthropic.py
      index.py
    memory.py
    preamble.py
    streaming.py
    events.py
    sandbox.py
```

---

## Dependencies (`pyproject.toml`)

```toml
[project]
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "langgraph>=0.2",
  "langchain-anthropic>=0.3",
  "langchain-openai>=0.2",
  "langchain-mcp-adapters>=0.1",
  "anthropic>=0.40",
  "yfinance>=0.2",
  "alpha-vantage>=3.0",
  "pycoingecko>=3.1",
  "python-dotenv>=1.0",
  "sse-starlette>=2.0",
  "langgraph-checkpoint-sqlite",
]
```

---

## Environment Variables

### New (add to `.env` and `.env.example`)

```
ALPHA_VANTAGE_API_KEY=
COINGECKO_API_KEY=        # optional
GMAIL_TOKEN=
OUTLOOK_TOKEN=
```

### Unchanged

`ANTHROPIC_API_KEY`, `FIREWORKS_API_KEY`, `FIREWORKS_MODEL`, `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `PROXY_API_KEY`, `PROXY_PORT`, `AGENT_ENABLE_WEB_SEARCH`, `AGENT_ENABLE_COMMANDS`, `AGENT_ENABLE_MEMORY`, `JARVIS_MEMORY_STORE_NAME`, `AGENT_NOTION_READONLY`, `JARVUS_PREAMBLE_ENABLED`, `JARVUS_HEARTBEAT_MS`.

---

## Root `package.json` additions

```json
"agent":      "cd agent && uv run uvicorn src.server:app --port 8787 --reload",
"agent:prod": "cd agent && uv run uvicorn src.server:app --port 8787"
```

---

## What is NOT changing

- Tauri frontend (`frontend/`) — zero changes
- TTS server (`tts/`) — zero changes
- Wake word / STT sidecar (`frontend/src-tauri/`) — zero changes
- `.env` existing variables — all preserved
- OpenAI-compat SSE wire format — identical
- Workspace sandbox behaviour — identical
- Mutating tool confirmation gate — identical
- Heartbeat filler behaviour — identical
