// proxy/src/providers/anthropic.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicProvider } from "./anthropic.js";

test("createAnthropicProvider returns an object with streamTurn", () => {
  const provider = createAnthropicProvider({ apiKey: "test-key" });
  assert.equal(typeof provider.streamTurn, "function");
});

test("streamTurn calls onText for each text delta", async () => {
  const fakeClient = {
    messages: {
      stream(_params) {
        const listeners = {};
        return {
          on(event, cb) { listeners[event] = cb; return this; },
          finalMessage: async () => {
            listeners.text?.("hello ");
            listeners.text?.("world");
            return { stop_reason: "end_turn", content: [{ type: "text", text: "hello world" }] };
          },
        };
      },
    },
  };

  const provider = createAnthropicProvider({ apiKey: "k", _clientOverride: fakeClient });
  let collected = "";
  const result = await provider.streamTurn(
    { model: "m", max_tokens: 64, system: [], tools: [], messages: [] },
    (delta) => { collected += delta; }
  );

  assert.equal(collected, "hello world");
  assert.equal(result.stop_reason, "end_turn");
});
