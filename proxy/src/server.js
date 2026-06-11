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
import { resolveStoreId, memoryRecall, appendMemoryBlock } from "./memory.js";
import { createProvider } from "./providers/index.js";
import { createFireworksProvider } from "./providers/fireworks.js";
import { runWithPreamble } from "./preamble.js";

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
  FIREWORKS_API_KEY = "",
  FIREWORKS_MODEL = "accounts/fireworks/models/gpt-oss-120b",
  FIREWORKS_FALLBACK_ENABLED = "true",
  FIREWORKS_PREAMBLE_MODEL = "accounts/fireworks/models/gpt-oss-120b",
  JARVUS_PREAMBLE_ENABLED = "true",
  AGENT_NOTION_READONLY = "true",
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("[proxy] FATAL: ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const DEFAULT_MAX_TOKENS = Number.parseInt(ANTHROPIC_MAX_TOKENS, 10) || 1024;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const provider = createProvider(process.env);
const preambleProvider =
  FIREWORKS_API_KEY && JARVUS_PREAMBLE_ENABLED !== "false"
    ? createFireworksProvider({
        apiKey: FIREWORKS_API_KEY,
        model: FIREWORKS_PREAMBLE_MODEL,
        extraBody: { reasoning_effort: "low" },
      })
    : null;

// Spoken filler streamed when the model goes quiet mid-turn, so the user is
// never met with silence while a tool runs or the model is thinking.
const HEARTBEAT_MS = Number.parseInt(process.env.JARVUS_HEARTBEAT_MS || "1500", 10) || 1500;
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
    description: "OpenAI-compatible bridge to the Anthropic Claude API.",
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
  const wantStream = body.stream !== false;
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

  // Mirror the user's utterance to the agent console.
  const userText = lastSpokenUserText(body.messages);
  if (userText) broadcast({ type: "transcript", role: "user", text: userText });

  // Restore working memory (tool results + drafts) so the agent never "starts
  // fresh" after a confirm step. Falls back to the fresh messages for a new conversation.
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
        provider,
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

  // Streaming (SSE) path.
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
    // Heartbeat: stream a short filler if the model goes quiet (thinking or a
    // slow tool call), so the user is never met with dead air. Filler is not
    // added to agentText — the console transcript and memory stay clean.
    let lastActivity = Date.now();
    let fillerIdx = -1;
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity < HEARTBEAT_MS) return;
      fillerIdx = (fillerIdx + 1) % HEARTBEAT_FILLERS.length;
      const lead = agentText && !/\s$/.test(agentText) ? " " : "";
      send(streamChunk({ id, created, model, delta: { content: `${lead}${HEARTBEAT_FILLERS[fillerIdx]} ` } }));
      lastActivity = Date.now();
    }, 500);

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
    const primaryModel = FIREWORKS_API_KEY ? FIREWORKS_MODEL : ANTHROPIC_MODEL;
    const fallback =
      !FIREWORKS_API_KEY ? "none" : FIREWORKS_FALLBACK_ENABLED !== "false" ? ANTHROPIC_MODEL : "disabled";
    console.log(`[proxy] model=${primaryModel}  fallback=${fallback}  auth=${PROXY_ALLOW_UNAUTHENTICATED === "true" || !PROXY_API_KEY ? "disabled" : "enabled"}`);
    console.log(`[proxy] agent tools: ${toolNames.join(", ")}`);
    console.log(`[proxy] workspace: ${AGENT_WORKSPACE}  commands=${agentCfg.enableCommands ? "enabled" : "disabled"}`);

  });
}

start();
