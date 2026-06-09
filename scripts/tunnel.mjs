#!/usr/bin/env node
// Starts a free Cloudflare quick tunnel to the local proxy and writes the public
// URL into the repo-root .env as PUBLIC_PROXY_BASE_URL, so the setup script, web
// backend, and desktop app all pick it up automatically. Keep this running while
// you use the agent; Ctrl-C tears the tunnel down.
//
//   node scripts/tunnel.mjs            # tunnels http://localhost:8787
//   node scripts/tunnel.mjs 9000       # tunnels a different port

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = resolve(ROOT, ".env");
const PORT = process.argv[2] || "8787";

function upsertEnv(key, value) {
  let text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text += (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
  }
  writeFileSync(ENV_PATH, text);
}

console.log(`[tunnel] starting Cloudflare quick tunnel → http://localhost:${PORT}`);
const cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${PORT}`], {
  stdio: ["ignore", "pipe", "pipe"],
});

let captured = false;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function scan(buf) {
  const s = buf.toString();
  process.stderr.write(s); // pass cloudflared's own logs through
  if (captured) return;
  const m = s.match(URL_RE);
  if (m) {
    captured = true;
    const base = `${m[0]}/v1`;
    upsertEnv("PUBLIC_PROXY_BASE_URL", base);
    console.log("\n──────────────────────────────────────────────────────────────");
    console.log(`[tunnel] public URL: ${m[0]}`);
    console.log(`[tunnel] wrote PUBLIC_PROXY_BASE_URL=${base} to .env`);
    console.log("[tunnel] now run:  node scripts/setup-tavus.mjs   (or launch the app)");
    console.log("[tunnel] leave this running; Ctrl-C closes the tunnel.");
    console.log("──────────────────────────────────────────────────────────────\n");
  }
}

cf.stdout.on("data", scan);
cf.stderr.on("data", scan);
cf.on("exit", (code) => {
  console.log(`[tunnel] cloudflared exited (${code}).`);
  process.exit(code ?? 0);
});
process.on("SIGINT", () => cf.kill("SIGINT"));
