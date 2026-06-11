// Tool registry for the agent: Anthropic tool definitions + server-side executors.
//
// - web_search is an Anthropic SERVER tool (executed by Anthropic, no executor here).
// - read-only tools (list_dir, read_file, search_files) auto-execute.
// - mutating tools (write_file, edit_file, run_command) require `user_confirmed: true`,
//   are audited, and are bounded by the sandbox.

import { readFile, writeFile, readdir, stat, appendFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  resolveInWorkspace,
  toWorkspaceRelative,
  workspaceRoot,
  commandDenyReason,
} from "./sandbox.js";

const execAsync = promisify(exec);
const MAX_READ_BYTES = 200_000;
const COMMAND_TIMEOUT_MS = 30_000;

// ── Anthropic tool definitions (sent to the Messages API) ─────────────────────
const READ_ONLY_DEFS = [
  {
    name: "list_dir",
    description:
      "List files and folders inside the agent workspace. Use before reading or writing to discover what exists.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory path. Use '.' for the workspace root." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace. Returns up to ~200KB.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
      },
      required: ["path"],
    },
  },
  {
    name: "search_files",
    description: "Search file contents in the workspace for a substring (case-insensitive). Returns matching files and line snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for." },
        path: { type: "string", description: "Workspace-relative directory to search under. Use '.' for the whole workspace." },
      },
      required: ["query", "path"],
    },
  },
];

const MUTATING_DEFS = [
  {
    name: "write_file",
    description:
      "Create or overwrite a text file in the workspace. MUTATING: first tell the user what you'll write and get a spoken 'yes'; only then call this with user_confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        content: { type: "string", description: "Full file contents to write." },
        user_confirmed: { type: "boolean", description: "True ONLY after the user verbally approved this specific write." },
      },
      required: ["path", "content", "user_confirmed"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace the first exact occurrence of old_text with new_text in a workspace file. MUTATING: confirm with the user first, then call with user_confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path." },
        old_text: { type: "string", description: "Exact text to find (must be unique enough to match once)." },
        new_text: { type: "string", description: "Replacement text." },
        user_confirmed: { type: "boolean", description: "True ONLY after the user verbally approved this specific edit." },
      },
      required: ["path", "old_text", "new_text", "user_confirmed"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command with the workspace as the working directory. MUTATING and powerful: state the exact command, get a spoken 'yes', then call with user_confirmed=true.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
        user_confirmed: { type: "boolean", description: "True ONLY after the user verbally approved this exact command." },
      },
      required: ["command", "user_confirmed"],
    },
  },
];

/** Build the tool list sent to Anthropic, given config. */
export function buildToolDefs(cfg) {
  const tools = [];
  if (cfg.webSearch) {
    // Basic web_search (no code-execution dependency) — broadly compatible.
    tools.push({
      type: "web_search_20250305",
      name: "web_search",
      max_uses: cfg.webSearchMaxUses ?? 5,
    });
  }
  tools.push(...READ_ONLY_DEFS);
  // Display-only: surfaces media in the side console (handled in agent.js, not executeTool).
  tools.push({
    name: "show_media",
    description:
      "Display an image, video, or link to the user in the side console panel (this does NOT speak it aloud). Use it to show pictures, screenshots, charts, diagrams, or a video/page you found or generated. Provide a direct URL.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Direct URL to the image/video/page." },
        media_type: { type: "string", enum: ["image", "video", "link"], description: "What kind of media the URL is." },
        caption: { type: "string", description: "A short caption shown under the media." },
      },
      required: ["url", "media_type", "caption"],
    },
  });
  // Long-term memory (backed by the managed memory store) — handled in agent.js.
  if (cfg.memory) {
    tools.push(
      {
        name: "memory_recall",
        description:
          "Search long-term memory mid-conversation for specific details not already in the injected <memory> block — preferences, projects, or prior context that persists across conversations. Optionally pass a query to filter.",
        input_schema: {
          type: "object",
          properties: { query: { type: "string", description: "Optional substring to filter memories by." } },
          required: [],
        },
      },
      {
        name: "memory_read",
        description: "Read one memory document by its path (e.g. /profile/owner.md).",
        input_schema: {
          type: "object",
          properties: { path: { type: "string", description: "Memory path, starting with /." } },
          required: ["path"],
        },
      },
      {
        name: "memory_save",
        description:
          "Save or update a durable fact in long-term memory so you remember it in future conversations — user preferences, ongoing projects, decisions, important context. Use clear paths like /profile/owner.md or /projects/tavus-agent.md.",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Memory path, starting with / (e.g. /profile/owner.md)." },
            content: { type: "string", description: "The full content to store at this path." },
          },
          required: ["path", "content"],
        },
      },
    );
  }

  for (const def of MUTATING_DEFS) {
    if (def.name === "run_command" && !cfg.enableCommands) continue;
    tools.push(def);
  }
  return tools;
}

const MUTATING = new Set(["write_file", "edit_file", "run_command"]);
export const isMutating = (name) => MUTATING.has(name);

async function auditLog(env, line) {
  try {
    const file = path.join(workspaceRoot(env), ".agent-audit.log");
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* never let auditing break a turn */
  }
}

// ── Executor ──────────────────────────────────────────────────────────────────
/**
 * Execute a locally-handled tool. Returns a string result (errors are returned as
 * strings prefixed with "ERROR:" so they flow back to Claude as tool_result content,
 * letting it recover/ask rather than crashing the turn).
 */
export async function executeTool(name, input = {}, { env = process.env, cfg = {} } = {}) {
  try {
    // Gate mutating tools on explicit confirmation.
    if (MUTATING.has(name) && input.user_confirmed !== true) {
      return "ERROR: This action changes state and was not confirmed. Tell the user exactly what you intend to do and ask for explicit approval, then retry with user_confirmed=true.";
    }
    if (name === "run_command" && !cfg.enableCommands) {
      return "ERROR: run_command is disabled (AGENT_ENABLE_COMMANDS is not true).";
    }

    switch (name) {
      case "list_dir": {
        const dir = resolveInWorkspace(input.path || ".", env);
        const entries = await readdir(dir, { withFileTypes: true });
        if (!entries.length) return "(empty)";
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
      }
      case "read_file": {
        const file = resolveInWorkspace(input.path, env);
        const buf = await readFile(file);
        const text = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
        return buf.length > MAX_READ_BYTES ? `${text}\n…(truncated)` : text;
      }
      case "search_files": {
        const base = resolveInWorkspace(input.path || ".", env);
        const hits = await searchFiles(base, String(input.query || ""), env);
        return hits.length ? hits.join("\n") : "No matches.";
      }
      case "write_file": {
        const file = resolveInWorkspace(input.path, env);
        await writeFile(file, String(input.content ?? ""), "utf8");
        const rel = toWorkspaceRelative(file, env);
        await auditLog(env, `write_file ${rel} (${Buffer.byteLength(String(input.content ?? ""))} bytes)`);
        return `Wrote ${rel}.`;
      }
      case "edit_file": {
        const file = resolveInWorkspace(input.path, env);
        const before = await readFile(file, "utf8");
        if (!before.includes(input.old_text)) return "ERROR: old_text not found in the file.";
        const after = before.replace(input.old_text, input.new_text);
        await writeFile(file, after, "utf8");
        const rel = toWorkspaceRelative(file, env);
        await auditLog(env, `edit_file ${rel}`);
        return `Edited ${rel}.`;
      }
      case "run_command": {
        const deny = commandDenyReason(input.command);
        if (deny) {
          await auditLog(env, `run_command BLOCKED: ${input.command} :: ${deny}`);
          return `ERROR: ${deny}`;
        }
        await auditLog(env, `run_command: ${input.command}`);
        try {
          const { stdout, stderr } = await execAsync(input.command, {
            cwd: workspaceRoot(env),
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 1_000_000,
          });
          const out = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
            .filter(Boolean)
            .join("\n");
          return out.trim() || "(command produced no output)";
        } catch (err) {
          return `Command failed (exit ${err.code ?? "?"}): ${err.stderr || err.message}`;
        }
      }
      default:
        return `ERROR: unknown tool "${name}".`;
    }
  } catch (err) {
    return `ERROR: ${err.message}`;
  }
}

async function searchFiles(base, query, env, acc = [], depth = 0) {
  if (!query || depth > 6 || acc.length >= 50) return acc;
  const q = query.toLowerCase();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(base, e.name);
    if (e.isDirectory()) {
      await searchFiles(full, query, env, acc, depth + 1);
    } else {
      try {
        const s = await stat(full);
        if (s.size > MAX_READ_BYTES) continue;
        const text = await readFile(full, "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && acc.length < 50; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            acc.push(`${toWorkspaceRelative(full, env)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
          }
        }
      } catch {
        /* skip unreadable/binary */
      }
    }
  }
  return acc;
}
