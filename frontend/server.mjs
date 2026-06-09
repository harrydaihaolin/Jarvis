// Frontend dev backend: creates/ends Tavus conversations SERVER-SIDE so the
// browser never sees TAVUS_API_KEY. Vite proxies /api/* here (see vite.config.ts).
//
// Run:  node server.mjs        (reads the repo-root .env)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  configFromEnv,
  ensurePersona,
  createConversation,
  endConversation,
} from "../lib/tavus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Load repo-root .env (no dependency).
try {
  const raw = readFileSync(resolve(ROOT, ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
} catch {
  console.warn("[backend] No repo-root .env found.");
}

const PORT = Number.parseInt(process.env.FRONTEND_BACKEND_PORT || "8788", 10);

// Cache the persona so we don't create a new one on every "Start".
let cachedPersonaId = null;

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  try {
    const cfg = configFromEnv();

    if (req.method === "POST" && req.url === "/api/conversation") {
      if (!cachedPersonaId) {
        const { personaId, reused } = await ensurePersona(cfg, { log: (m) => console.log("[backend]", m) });
        cachedPersonaId = personaId;
        console.log(`[backend] persona ${reused ? "reused" : "created"}: ${personaId}`);
      }
      const convo = await createConversation(cfg, cachedPersonaId);
      console.log(`[backend] conversation ${convo.conversation_id} (test_mode=${cfg.testMode})`);
      return send(res, 200, {
        conversation_id: convo.conversation_id,
        conversation_url: convo.conversation_url,
        status: convo.status,
        test_mode: cfg.testMode,
      });
    }

    const endMatch = req.method === "POST" && req.url?.match(/^\/api\/conversation\/([^/]+)\/end$/);
    if (endMatch) {
      await endConversation(cfg, endMatch[1]);
      console.log(`[backend] ended conversation ${endMatch[1]}`);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, {
        ok: true,
        mode: cfg.useHosted ? "tavus-hosted" : "custom-proxy",
        test_mode: cfg.testMode,
      });
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[backend] error:", err?.message || err);
    send(res, 500, { error: err?.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}  (POST /api/conversation)`);
});
