#!/usr/bin/env node
// Creates (or reuses) a Tavus persona wired to our Claude proxy as a custom LLM,
// then creates a conversation and prints the conversation_url.
//
// Usage:
//   node scripts/setup-tavus.mjs                 # create persona + conversation
//   node scripts/setup-tavus.mjs --persona-only  # just create/print the persona
//   node scripts/setup-tavus.mjs --dry-run       # print payloads, call nothing
//
// Reads configuration from the repo-root .env (see .env.example).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TAVUS_BASE,
  configFromEnv,
  buildLlmLayer,
  buildPersonaPayload,
  ensurePersona,
  createConversation,
} from "../lib/tavus.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const log = (m) => console.log(`[setup] ${m}`);

// ── Minimal .env loader (no dependency) ──────────────────────────────────────
function loadEnv() {
  try {
    const raw = readFileSync(resolve(ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    console.warn("[setup] No .env at repo root — relying on process env. Copy .env.example to .env.");
  }
}
loadEnv();

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const PERSONA_ONLY = args.has("--persona-only");
const cfg = configFromEnv();

function die(msg) {
  console.error(`\n[setup] ERROR: ${msg}\n`);
  process.exit(1);
}

(async () => {
  if (cfg.useHosted) log(`Option A: Tavus-hosted model "${cfg.hostedModel}" (no proxy).`);
  else log(`Option B: custom Claude proxy (model reported as ${cfg.anthropicModel}).`);

  // Persona
  let personaId;
  if (DRY_RUN) {
    const llm = await buildLlmLayer(cfg, { log });
    console.log("\n[dry-run] POST /v2/personas\n" + JSON.stringify(buildPersonaPayload(cfg, llm), null, 2));
    personaId = "persona_dry_run";
  } else {
    const { personaId: pid, reused } = await ensurePersona(cfg, { log });
    personaId = pid;
    log(reused ? `Reusing persona ${pid}` : `Created persona ${pid}`);
  }

  if (PERSONA_ONLY) {
    log(`Persona ready: ${personaId}. (--persona-only, skipping conversation.)`);
    return;
  }

  // Conversation
  if (DRY_RUN) {
    console.log(
      "\n[dry-run] POST /v2/conversations\n" +
        JSON.stringify(
          {
            persona_id: personaId,
            replica_id: cfg.replicaId,
            custom_greeting: cfg.greeting,
            test_mode: cfg.testMode,
            properties: { enable_recording: false, max_call_duration: 600 },
          },
          null,
          2,
        ),
    );
    return;
  }

  const convo = await createConversation(cfg, personaId);
  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  conversation_id : ${convo.conversation_id}`);
  console.log(`  status          : ${convo.status}`);
  console.log(`  test_mode       : ${cfg.testMode}`);
  console.log(`\n  ▶ conversation_url:\n    ${convo.conversation_url}`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  Open it directly, or start the frontend (http://localhost:5173).");
  console.log("  End it (stops billing) with:");
  console.log(`    curl -X POST ${TAVUS_BASE}/conversations/${convo.conversation_id}/end -H "x-api-key: $TAVUS_API_KEY"`);
})().catch((err) => die(err?.stack || String(err)));
