import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgent } from "./agent.js";

const env = { AGENT_WORKSPACE: mkdtempSync(path.join(tmpdir(), "agent-")) };
const cfg = { webSearch: false, enableCommands: false, maxIterations: 8 };

function fakeProvider(scripted) {
  let i = 0;
  return {
    async streamTurn(_params, onText) {
      const step = scripted[Math.min(i, scripted.length - 1)];
      i += 1;
      if (onText && step.text) for (const t of step.text) onText(t);
      return step.final;
    },
  };
}

test("runs a tool then streams the final answer", async () => {
  const provider = fakeProvider([
    {
      text: ["Let me check. "],
      final: {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me check. " },
          { type: "tool_use", id: "t1", name: "list_dir", input: { path: "." } },
        ],
      },
    },
    {
      text: ["The folder is empty."],
      final: { stop_reason: "end_turn", content: [{ type: "text", text: "The folder is empty." }] },
    },
  ]);

  let out = "";
  const events = [];
  const { finishReason } = await runAgent({
    provider,
    baseParams: { model: "m", max_tokens: 256, messages: [{ role: "user", content: "what's in my workspace?" }] },
    cfg,
    env,
    onText: (t) => (out += t),
    onEvent: (e) => events.push(e),
  });

  assert.equal(out, "Let me check. The folder is empty.");
  assert.equal(finishReason, "stop");
  assert.ok(events.some((e) => e.type === "tool_call" && e.name === "list_dir"));
});

test("handles pause_turn (server tool) then finishes", async () => {
  const provider = fakeProvider([
    { text: ["Searching… "], final: { stop_reason: "pause_turn", content: [{ type: "text", text: "Searching… " }] } },
    { text: ["Here's what I found."], final: { stop_reason: "end_turn", content: [{ type: "text", text: "Here's what I found." }] } },
  ]);
  let out = "";
  const { finishReason } = await runAgent({
    provider,
    baseParams: { model: "m", max_tokens: 256, messages: [{ role: "user", content: "search x" }] },
    cfg,
    env,
    onText: (t) => (out += t),
  });
  assert.equal(out, "Searching… Here's what I found.");
  assert.equal(finishReason, "stop");
});

test("respects the iteration cap when tools loop forever", async () => {
  const provider = fakeProvider([
    {
      text: ["."],
      final: {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t", name: "list_dir", input: { path: "." } }],
      },
    },
  ]);
  let calls = 0;
  const { iterations } = await runAgent({
    provider,
    baseParams: { model: "m", max_tokens: 64, messages: [{ role: "user", content: "loop" }] },
    cfg: { ...cfg, maxIterations: 3 },
    env,
    onText: () => (calls += 1),
  });
  assert.equal(iterations, 3);
});
