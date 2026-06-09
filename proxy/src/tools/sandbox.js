// Filesystem + command sandbox. Every file path the agent touches is forced to
// live inside AGENT_WORKSPACE, and commands run with that workspace as cwd under
// a denylist + timeout. This bounds the blast radius even if confirmation fails.

import { realpathSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/** Absolute, symlink-resolved workspace root. Created if missing. */
export function workspaceRoot(env = process.env) {
  const raw = env.AGENT_WORKSPACE || "./workspace";
  const abs = path.resolve(raw);
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true });
  // realpath so symlinked roots normalize consistently with resolveInWorkspace.
  return realpathSync(abs);
}

/**
 * Resolve a user/agent-supplied relative path to an absolute path that is
 * guaranteed to be inside the workspace. Throws on any escape attempt.
 *
 * Defends against: absolute paths, `..` traversal, and symlinks that point out
 * of the workspace (the nearest existing ancestor is realpath-checked).
 */
export function resolveInWorkspace(relPath, env = process.env) {
  const root = workspaceRoot(env);
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error("path is required");
  }
  if (path.isAbsolute(relPath)) {
    throw new Error("absolute paths are not allowed; use a path relative to the workspace");
  }

  const candidate = path.resolve(root, relPath);

  // Lexical containment check.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw new Error("path escapes the workspace");
  }

  // Symlink check: realpath the deepest existing ancestor and re-verify containment.
  let existing = candidate;
  while (!existsSync(existing) && existing !== path.dirname(existing)) {
    existing = path.dirname(existing);
  }
  if (existsSync(existing)) {
    const real = realpathSync(existing);
    if (real !== root && !real.startsWith(rootWithSep)) {
      throw new Error("path resolves (via symlink) outside the workspace");
    }
  }

  return candidate;
}

/** A short workspace-relative label for logs/results. */
export function toWorkspaceRelative(absPath, env = process.env) {
  return path.relative(workspaceRoot(env), absPath) || ".";
}

// Patterns that are refused outright regardless of confirmation. Defense in
// depth, not a complete shell parser — the workspace cwd is the real boundary.
const DENY_PATTERNS = [
  /\brm\s+-\w*r\w*\s+\/(?:\s|$)/, // rm -rf /
  /\bsudo\b/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  /\bmkfs\b|\bdd\s+if=/,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb :(){ :|:& };:
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, // curl ... | sh
  />\s*\/dev\/sd[a-z]/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bgit\s+push\b/, // pushing is outward-facing; keep it out of autonomous reach
]

/** Returns null if the command is allowed, or a reason string if denied. */
export function commandDenyReason(command) {
  if (typeof command !== "string" || !command.trim()) return "command is required";
  for (const re of DENY_PATTERNS) {
    if (re.test(command)) return `command matches a blocked pattern (${re})`;
  }
  return null;
}
