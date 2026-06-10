import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import {
  openaiToAnthropic,
  streamChunk,
  completionResponse,
  cleanSpokenText,
  lastSpokenUserText,
} from "./translate.js";
import { resumeOrStart, rememberTurn } from "./conversation.js";
import { runAgent } from "./agent.js";
import { buildToolDefs } from "./tools/index.js";
import { addClient, broadcast, clientCount } from "./events.js";
import { resolveStoreId } from "./memory.js";

// Load root .env (one level up) so the whole project shares one env file.
dotenv.config({ path: new URL("../../.env", import.meta.url).pathname });
dotenv.config(); // also pick up proxy/.env if present

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-4-6",
  ANTHROPIC_MAX_TOKENS = "1024",
  PROXY_PORT = "8787",
  PROXY_API_KEY,
  PROXY_ALLOW_UNAUTHENTICATED = "false",
  AGENT_ENABLE_WEB_SEARCH = "true",
  WEB_SEARCH_MAX_USES = "5",
  AGENT_ENABLE_COMMANDS = "false",
  AGENT_MAX_TOOL_ITERATIONS = "8",
  AGENT_WORKSPACE = "./workspace",
  AGENT_ENABLE_MEMORY = "true",
  JARVIS_MEMORY_STORE_NAME = "jarvis-memory",
  JARVIS_MEMORY_STORE_ID = "",
  NOTION_MCP_URL = "https://mcp.notion.com/mcp",
  NOTION_MCP_TOKEN = "",
  AGENT_NOTION_READONLY = "true",
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("[proxy] FATAL: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const DEFAULT_MAX_TOKENS = Number.parseInt(ANTHROPIC_MAX_TOKENS, 10) || 1024;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Spoken filler streamed to Tavus when the model goes quiet mid-turn, so the
// replica never sits in silence while a tool runs or the model is thinking.
const HEARTBEAT_MS = Number.parseInt(process.env.JARVUS_HEARTBEAT_MS || "4500", 10) || 4500;
const HEARTBEAT_FILLERS = [
  "Still on it, one sec.",
  "Almost there.",
  "Hang tight, just a moment.",
  "Still working on that.",
];

// Agent capabilities (the proxy runs Claude's tool-use loop server-side).
const agentCfg = {
  webSearch: AGENT_ENABLE_WEB_SEARCH !== "false",
  webSearchMaxUses: Number.parseInt(WEB_SEARCH_MAX_USES, 10) || 5,
  enableCommands: AGENT_ENABLE_COMMANDS === "true",
  maxIterations: Number.parseInt(AGENT_MAX_TOOL_ITERATIONS, 10) || 8,
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ── Auth ────────────────────────────────────────────────────────────────────
// Tavus sends the persona's llm.api_key back as `Authorization: Bearer <key>`.
function authorize(req, res) {
  if (PROXY_ALLOW_UNAUTHENTICATED === "true" || !PROXY_API_KEY) return true;
  const header = req.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token && token === PROXY_API_KEY) return true;
  res.status(401).json({ error: { message: "Unauthorized", type: "invalid_request_error" } });
  return false;
}

// ── Health & info ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", model: ANTHROPIC_MODEL }));
app.get("/", (_req, res) =>
  res.json({
    name: "jarvus-proxy",
    description: "OpenAI-compatible bridge to the Anthropic Claude API for Tavus CVI.",
    endpoints: ["/v1/chat/completions", "/v1/models", "/health"],
    model: ANTHROPIC_MODEL,
  }),
);

// Some OpenAI clients probe /v1/models first.
app.get(["/v1/models", "/models"], (_req, res) =>
  res.json({
    object: "list",
    data: [{ id: ANTHROPIC_MODEL, object: "model", owned_by: "anthropic" }],
  }),
);

// ── Agent console event stream (SSE) ───────────────────────────────────────────
// The frontend connects here (directly, over localhost) for a live feed of the
// agent's transcript, tool activity, citations, and media.
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  addClient(res);
  // Heartbeat so proxies/tunnels keep the stream open.
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15000);
  req.on("close", () => clearInterval(ping));
});

// ── Chat completions ──────────────────────────────────────────────────────────
async function handleChatCompletions(req, res) {
  if (!authorize(req, res)) return;

  const body = req.body || {};
  const wantStream = body.stream !== false; // default to streaming (Tavus requires SSE)
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let params;
  try {
    params = openaiToAnthropic(body, {
      defaultModel: ANTHROPIC_MODEL,
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    });
  } catch (err) {
    return res.status(400).json({ error: { message: `Bad request: ${err.message}`, type: "invalid_request_error" } });
  }

  const model = params.model;

  // Mirror the user's spoken utterance to the agent console — stripping the
  // Tavus perception metadata (appearance/audio/emotion blocks) so the dialog
  // shows only real words, not raven's analysis.
  const userText = lastSpokenUserText(body.messages);
  if (userText) broadcast({ type: "transcript", role: "user", text: userText });

  // Restore this conversation's working memory (tool results + drafts from prior
  // turns) so the agent never "starts fresh" after a confirm step. Tavus only
  // carries spoken text forward; we carry the rest. Falls back to the freshly
  // translated messages for a brand-new conversation.
  const { messages: runMessages } = resumeOrStart(body.messages, params.messages);
  params = { ...params, messages: runMessages };

  // Forward structured agent steps to the console (and log them).
  const onEvent = (evt) => {
    broadcast(evt);
    if (evt.type === "tool_call") console.log(`[agent] → ${evt.name}(${Object.keys(evt.input || {}).join(", ")})`);
    else if (evt.type === "tool_result") console.log(`[agent] ← ${evt.name}${evt.isError ? " [error]" : " ok"}`);
  };

  if (!wantStream) {
    try {
      let text = "";
      const { finishReason, messages } = await runAgent({
        anthropic,
        baseParams: params,
        cfg: agentCfg,
        onText: (delta) => {
          text += delta;
        },
        onEvent,
      });
      rememberTurn(messages, text);
      const spokenReply = cleanSpokenText(text);
      if (spokenReply) broadcast({ type: "transcript", role: "assistant", text: spokenReply });
      return res.json(completionResponse({ id, created, model, text, finishReason }));
    } catch (err) {
      return sendError(res, err);
    }
  }

  // Streaming (SSE) path — this is what Tavus uses.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

  try {
    // Opening chunk advertising the assistant role (OpenAI convention).
    send(streamChunk({ id, created, model, delta: { role: "assistant", content: "" } }));

    let agentText = "";
    // Heartbeat: if the model goes quiet (thinking, or a multi-second web_search
    // is running) for too long, speak a short filler so the replica never sits
    // in dead air. Filler is streamed to Tavus only — not added to agentText, so
    // the console transcript and conversation memory stay clean.
    let lastActivity = Date.now();
    let fillerIdx = -1;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity < HEARTBEAT_MS) return;
      fillerIdx = (fillerIdx + 1) % HEARTBEAT_FILLERS.length;
      const lead = agentText && !/\s$/.test(agentText) ? " " : "";
      send(streamChunk({ id, created, model, delta: { content: `${lead}${HEARTBEAT_FILLERS[fillerIdx]} ` } }));
      lastActivity = Date.now();
    }, 1000);

    let finishReason;
    let messages;
    try {
      ({ finishReason, messages } = await runAgent({
        anthropic,
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

    rememberTurn(messages, agentText);
    const spokenReply = cleanSpokenText(agentText);
    if (spokenReply) broadcast({ type: "transcript", role: "assistant", text: spokenReply });
    send(streamChunk({ id, created, model, delta: {}, finishReason }));
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    // If headers already sent, surface the error inside the stream then close.
    console.error("[proxy] stream error:", err?.message || err);
    try {
      send(streamChunk({ id, created, model, delta: { content: "" }, finishReason: "stop" }));
      res.write("data: [DONE]\n\n");
    } catch {
      /* ignore */
    }
    res.end();
  }
}

app.post(["/v1/chat/completions", "/chat/completions"], handleChatCompletions);

function sendError(res, err) {
  const status = err?.status && Number.isInteger(err.status) ? err.status : 500;
  console.error("[proxy] error:", err?.message || err);
  return res.status(status).json({
    error: {
      message: err?.message || "Upstream Anthropic error",
      type: "api_error",
    },
  });
}

const port = Number.parseInt(PROXY_PORT, 10) || 8787;

async function start() {
  // Resolve the persistent memory store before serving (graceful if unavailable).
  if (AGENT_ENABLE_MEMORY !== "false") {
    try {
      const storeId = await resolveStoreId(anthropic, {
        idOverride: JARVIS_MEMORY_STORE_ID,
        name: JARVIS_MEMORY_STORE_NAME,
      });
      agentCfg.memory = { anthropic, storeId };
      console.log(`[proxy] memory: "${JARVIS_MEMORY_STORE_NAME}" → ${storeId}`);
    } catch (err) {
      console.warn(`[proxy] memory disabled: ${err.message}`);
    }
  }

  createServer(app).listen(port, () => {
    const toolNames = buildToolDefs(agentCfg).map((t) => t.name);
    console.log(`[proxy] listening on http://localhost:${port}`);
    console.log(`[proxy] model=${ANTHROPIC_MODEL}  auth=${PROXY_ALLOW_UNAUTHENTICATED === "true" || !PROXY_API_KEY ? "disabled" : "enabled"}`);
    console.log(`[proxy] agent tools: ${toolNames.join(", ")}`);
    console.log(`[proxy] workspace: ${AGENT_WORKSPACE}  commands=${agentCfg.enableCommands ? "enabled" : "disabled"}`);
    console.log(`[proxy] Tavus custom-LLM base_url should be:  <public-url>/v1`);
  });
}

start();
