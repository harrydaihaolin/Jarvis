import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildToolDefs, executeTool, isMutating } from "./index.js";

const env = { AGENT_WORKSPACE: mkdtempSync(path.join(tmpdir(), "tools-")) };

test("buildToolDefs includes web_search only when enabled, and gates run_command", () => {
  const withAll = buildToolDefs({ webSearch: true, enableCommands: true }).map((t) => t.name);
  assert.ok(withAll.includes("web_search"));
  assert.ok(withAll.includes("run_command"));

  const minimal = buildToolDefs({ webSearch: false, enableCommands: false }).map((t) => t.name);
  assert.ok(!minimal.includes("web_search"));
  assert.ok(!minimal.includes("run_command"));
  assert.ok(minimal.includes("read_file")); // read-only always present
});

test("isMutating flags state-changing tools", () => {
  assert.equal(isMutating("write_file"), true);
  assert.equal(isMutating("run_command"), true);
  assert.equal(isMutating("read_file"), false);
});

test("mutating tool without confirmation returns a confirmation error", async () => {
  const out = await executeTool("write_file", { path: "x.txt", content: "hi", user_confirmed: false }, { env, cfg: {} });
  assert.match(out, /not confirmed/i);
});

test("write_file then read_file round-trips when confirmed", async () => {
  const w = await executeTool("write_file", { path: "note.md", content: "hello world", user_confirmed: true }, { env, cfg: {} });
  assert.match(w, /Wrote/);
  const r = await executeTool("read_file", { path: "note.md" }, { env, cfg: {} });
  assert.equal(r, "hello world");
});

test("list_dir shows written files", async () => {
  const out = await executeTool("list_dir", { path: "." }, { env, cfg: {} });
  assert.match(out, /note\.md/);
});

test("edit_file replaces text", async () => {
  await executeTool("write_file", { path: "e.txt", content: "foo bar", user_confirmed: true }, { env, cfg: {} });
  const out = await executeTool("edit_file", { path: "e.txt", old_text: "foo", new_text: "baz", user_confirmed: true }, { env, cfg: {} });
  assert.match(out, /Edited/);
  assert.equal(await executeTool("read_file", { path: "e.txt" }, { env, cfg: {} }), "baz bar");
});

test("run_command is disabled unless enableCommands", async () => {
  const out = await executeTool("run_command", { command: "echo hi", user_confirmed: true }, { env, cfg: { enableCommands: false } });
  assert.match(out, /disabled/);
});

test("run_command blocks denylisted commands when enabled", async () => {
  const out = await executeTool("run_command", { command: "sudo rm -rf /", user_confirmed: true }, { env, cfg: { enableCommands: true } });
  assert.match(out, /ERROR/);
});

test("run_command runs a safe command in the workspace", async () => {
  const out = await executeTool("run_command", { command: "echo sandboxed", user_confirmed: true }, { env, cfg: { enableCommands: true } });
  assert.match(out, /sandboxed/);
});

test("path escape is rejected by the executor", async () => {
  const out = await executeTool("read_file", { path: "../../../etc/passwd" }, { env, cfg: {} });
  assert.match(out, /ERROR/);
});
