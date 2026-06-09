# Jarvus — Feature Design Spec
**Date:** 2026-06-08  
**Status:** Approved for implementation

---

## Overview

Six features across the Jarvus stack (formerly "Jarvis"). The project is renamed "Jarvus" and the
Tavus persona is a male stock replica also named "Jarvus". Features range from UI polish to a
local wake-word system backed by Tauri's Rust runtime.

---

## Feature 0 — Project rename: Jarvis → Jarvus

### Scope
- Rename the repo directory, npm package name, Tauri app name/identifier, and persona name
  everywhere they appear.
- Pick a male Tavus Phoenix stock replica and set `TAVUS_REPLICA_ID` + `PERSONA_NAME=Jarvus`
  in `.env`.

### Changes
| Location | Old value | New value |
|---|---|---|
| `package.json` `name` | `tavus-agent` | `jarvus` |
| `frontend/package.json` `name` | (whatever) | `jarvus-frontend` |
| `frontend/src-tauri/tauri.conf.json` `productName` | — | `Jarvus` |
| `frontend/src-tauri/tauri.conf.json` `identifier` | — | `com.jarvus.app` |
| `proxy/src/agent.js` system-prompt greeting | "video agent" | "Jarvus" |
| `.env.example` | `PERSONA_NAME=...` | `PERSONA_NAME=Jarvus` |
| `ANTHROPIC_MODEL` default comment | — | note Opus 4.7 for best results |
| `README.md`, `AGENTS.md` headings | tavus-agent | Jarvus |

The male replica ID is chosen manually from `GET /v2/replicas?replica_type=system` and set in
`.env`. The spec doesn't hardcode it — it's environment-specific.

---

## Feature 1 — Full-bleed video + AgentConsole overlay

### Current state
`.callRoot` is a side-by-side flex container: `callMain` (flex: 1) holds the Tavus
`<Conversation>` component; `AgentConsole` is beside it as a fixed-width sibling. The video
is left-aligned inside `callMain`.

### Design
- `.callRoot` → `position: relative; width: 100vw; height: 100vh; overflow: hidden`
- `.callMain` → `position: absolute; inset: 0` (fills the entire viewport, video is full-bleed)
- `AgentConsole` → `position: absolute; top: 0; right: 0; bottom: 0; width: 380px;
  background: rgba(10,14,26,0.88); backdrop-filter: blur(12px);
  border-left: 1px solid rgba(255,255,255,0.08)`
- The Tavus footer controls bar (mic, camera, chat, leave) lives inside `conversation.module.css`
  as `position: absolute; bottom: 0; left: 0; right: 0`. Its buttons are flex-centered, so on a
  typical desktop the cluster stays visible left of the overlay. To fully prevent any button
  being obscured, set `right: 380px` on `styles.footer` in `conversation.module.css`.
- The existing `ChatPanel` slide-in already positions itself within the `<Conversation>`
  container — no changes needed there.

### Files changed
- `frontend/src/App.css` — `.callRoot`, `.callMain`
- `frontend/src/AgentConsole.css` — `.console` becomes `position: absolute`

---

## Feature 2 — Notion MCP integration

### Configuration
```
# .env
NOTION_TOKEN=secret_...         # Notion integration token
NOTION_DATABASE_ID=<uuid>       # ID of the "Jarvus Notes" database
```

`.mcp.json` (project-scoped, already has `tavus-docs`):
```json
{
  "mcpServers": {
    "tavus-docs": { ... },
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": { "NOTION_TOKEN": "${NOTION_TOKEN}" }
    }
  }
}
```

### Notion database schema
Database name: **Jarvus Notes** (lives under the user's "Jarvus" Notion page).

| Property | Type | Notes |
|---|---|---|
| Name | Title | `YYYY-MM-DD — <topic>` auto-composed by agent |
| Date | Date | Set to today by the agent |
| Topic | Select | Agent infers from conversation context |

Page body: Notion block content — heading, paragraph blocks, image blocks (external URLs).

### Agent skill rules (added to `AGENTS.md`)

```markdown
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
```

### System prompt addition (`agent.js` AGENT_ADDENDUM)

```
Notion notes:
- NOTION_DATABASE_ID is available in your environment. Use the notion MCP tools.
- When taking notes, always include any image URLs from show_media calls made this session
  as Notion image blocks (type: "image", external: { url: "..." }).
- Page titles follow the format: YYYY-MM-DD — <topic>.
```

### Session image tracking (`agent.js`)
The `runAgent` function accumulates image URLs into a `sessionImages[]` array on each
`show_media` tool call. This array is passed as context when the agent calls
`notion.create_page`, so the agent can reference it in the `children` blocks it constructs.

---

## Feature 3 — Paste UX in chat

### Current state
`ChatPanel` (in `frontend/src/components/cvi/components/chat/index.tsx`) already has a
textarea composer wired to `sendMessage` (→ Tavus). It's toggled by `ChatButton` in the
Conversation footer.

### Design: large-paste abbreviation (≥ 500 chars)

**Composer behaviour:**
- Attach an `onPaste` handler to the `<textarea>`.
- If `pastedText.length >= 500`: store the full text in a `pastedContent` ref; replace the
  textarea value with an empty string; render a pill above the textarea:
  `📋 Pasted text · {N.toLocaleString()} chars  [✕]`
- The user may optionally type an additional note in the textarea below the pill
  (e.g. "Summarise this").
- On submit: send `${pastedContent}\n\n${note}` to Tavus (full text, no truncation).

**Message bubble behaviour:**
- `MessageBubble` checks if `message.text.length >= 500` AND the message was sent by the user.
- If so, render:  
  `📋 Pasted text · {N} chars`  
  `[Show full ▾]` toggle that expands inline.

**Files changed:**
- `frontend/src/components/cvi/components/chat/index.tsx` — `ChatPanel`, `MessageBubble`
- `frontend/src/components/cvi/components/chat/chat.module.css` — pill + expanded bubble styles

---

## Feature 4 — Image display from web search + Notion image blocks

### Current state
`show_media` tool is fully wired: proxy fires a `media` event; AgentConsole renders
`<img src={url} loading="lazy">` for `mediaType === "image"`. No changes needed to the
frontend or the tool definition.

### Design: system prompt instruction

Add to `AGENT_ADDENDUM` in `proxy/src/agent.js`:

```
Images and visuals:
- Whenever research yields a useful visual (stock chart, diagram, map, product image,
  infographic), call show_media with a direct image URL.
- Prefer stable CDN/embed URLs: Yahoo Finance chart embeds, Wikimedia Commons, news CDNs.
  Avoid URLs that require authentication or expire quickly.
- Never paste raw image URLs into your spoken reply. Use show_media instead — it displays
  silently in the console while you keep talking.
```

### Session image tracking
In `proxy/src/agent.js`, inside the `show_media` branch of the tool-use loop:

```js
if (b.name === "show_media") {
  const url = b.input?.url;
  if (b.input?.media_type === "image" && url) {
    sessionImages.push({ url, caption: b.input?.caption || "" });
  }
  onEvent?.({ type: "media", mediaType: b.input?.media_type || "link", url, caption: b.input?.caption || "" });
  results.push({ type: "tool_result", tool_use_id: b.id, content: "Displayed in the user's console." });
  continue;
}
```

`sessionImages` is initialised as `[]` at the top of `runAgent`. The agent already has access
to these images via the conversation message history (each `show_media` call appears as a
`tool_use` + `tool_result` pair in `messages`). No extra injection is needed — the agent can
reference those blocks when building the Notion page children.

---

## Feature 5 — Conversational pacing (system prompt)

Replace the existing one-liner in `AGENT_ADDENDUM`:
> *"Before any tool call that may take a moment... say a short out-loud line first"*

with a full **Pacing** section:

```
Pacing — keeping the conversation alive during work:
- Before starting any task that involves tool use, say what you're doing and give a time signal.
  Give a specific estimate when you can reason about complexity; use vague signals otherwise:
    Specific:  "Pulling the S&P data and building the chart — give me about a minute."
    Specific:  "This involves a few searches and a Notion save, maybe two minutes."
    Vague:     "Let me look that up — this might take a moment."
    Vague:     "On it, just a second."
- Between tool iterations in a multi-step chain, emit a brief status line so there's no silence:
    "Got the search results — now fetching the chart."
    "Still on it, almost there."
    "Found the data, writing the notes now."
- Draw from natural variants. Do not repeat the same phrase twice in a row.
- Never go silent for more than one tool round-trip without a status update.
```

**File changed:** `proxy/src/agent.js` — `AGENT_ADDENDUM` constant.

---

## Feature 6 — "Hey Jarvus" wake word + session sleep

### Goal
The Jarvus desktop app (Tauri v2) stays alive in the background as a macOS menu-bar app.
It listens locally for "Hey Jarvus", starts a Tavus conversation when heard, and automatically
ends the session after a configurable inactivity period.

### Wake word engine: Porcupine (Picovoice)
- **Why Porcupine**: purpose-built wake word detection, custom wake word ("Hey Jarvus"),
  Rust SDK (`pv_porcupine`), offline, ~1MB runtime, single AccessKey (free tier).
- Custom wake word file (`.ppn`) is generated via [Picovoice Console](https://console.picovoice.ai)
  and bundled in `frontend/src-tauri/resources/hey-jarvus.ppn`.
- Porcupine AccessKey stored in `.env` as `PICOVOICE_ACCESS_KEY`.

### Architecture

```
macOS audio (CPAL crate)
  → Porcupine Rust SDK (runs in a dedicated background thread)
  → on wake word detected: emit Tauri event "wake-word"
  → frontend receives event → calls createConversation() → starts Tavus session
  → start inactivity timer (reset on any Tavus speech/audio activity)
  → on timeout (default: 5 min, configurable via JARVUS_IDLE_TIMEOUT_SECS in .env)
    → end Tavus session, return app to idle/listening state
```

### Rust implementation (`frontend/src-tauri/src/`)

**New files:**
- `wake_word.rs` — background thread: initialises Porcupine, opens CPAL audio stream,
  feeds frames to Porcupine, emits `"wake-word"` Tauri event on detection.
  Thread is spawned once in `main.rs` and runs for the app's lifetime.
- `session.rs` — manages Tavus session state: active conversation ID, inactivity timer
  (Tokio `sleep`), end-conversation HTTP call. Exposes Tauri commands:
  `start_session(conversation_url)`, `reset_idle_timer()`, `end_session()`.

**Existing `tavus.rs`:** `create_conversation` and `end_conversation` Tauri commands remain
unchanged. `wake_word.rs` triggers `create_conversation` via an internal channel, not by
calling the JS layer directly.

### Inactivity / session sleep
- Idle timeout default: **5 minutes** (`JARVUS_IDLE_TIMEOUT_SECS=300`).
- Timer resets whenever the Tavus call has audio activity (detected via Daily/WebRTC track
  events forwarded from the frontend via `reset_idle_timer()` Tauri command).
- On timeout: `end_session()` calls `POST /v2/conversations/{id}/end`, clears state, and
  emits `"session-ended"` Tauri event → frontend returns to idle, Porcupine resumes listening.

### Cargo dependencies (`frontend/src-tauri/Cargo.toml`)
```toml
pv_porcupine = "3"   # Picovoice Porcupine Rust SDK
cpal = "0.15"         # Cross-platform audio I/O
tokio = { version = "1", features = ["time"] }
```

### macOS permissions
`frontend/src-tauri/Info.plist` already declares `NSMicrophoneUsageDescription`.
Background audio access: add `UIBackgroundModes` → `audio` in the plist (macOS equivalent
via `LSBackgroundOnly = false` — app remains in menu bar, not hidden).

Tauri config (`tauri.conf.json`):
```json
{
  "app": {
    "windows": [{ ... }],
    "trayIcon": { "iconPath": "icons/tray.png", "iconAsTemplate": true }
  }
}
```
App appears in the macOS menu bar tray when backgrounded (window hidden, tray icon visible).

### Frontend changes
- On `"wake-word"` event: call `createConversation()` → transition to `in-call` phase.
- On any Daily audio track activity: call `invoke("reset_idle_timer")`.
- On `"session-ended"` event: transition back to `idle` phase.
- Menu bar tray: "Open Jarvus" (show window) + "Quit" items.

### `.env.example` additions
```
PICOVOICE_ACCESS_KEY=           # From console.picovoice.ai (free tier)
JARVUS_IDLE_TIMEOUT_SECS=300    # Seconds of silence before session ends (default 5 min)
```

---

## Implementation order

1. **Rename** (F0) — pure find/replace, no logic changes. Do first so all subsequent commits
   use the right name.
2. **Video layout** (F1) — CSS only, isolated, verifiable in the browser immediately.
3. **Conversational pacing** (F5) — system prompt only, no structural changes.
4. **Paste UX** (F3) — frontend only, isolated to `chat/index.tsx`.
5. **Image tracking + system prompt** (F4) — proxy only, `agent.js`.
6. **Notion MCP** (F2) — `.mcp.json`, `.env.example`, `AGENTS.md`, `agent.js` system prompt.
7. **"Hey Jarvus" wake word** (F6) — Rust/Tauri, largest change, depends on rename being done.
