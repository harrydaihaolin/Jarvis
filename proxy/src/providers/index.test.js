// proxy/src/providers/index.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

// createProvider reads from env, so we inject env directly.
// We can't easily mock the sub-imports in ESM without dynamic import tricks,
// so we test the provider's external behaviour via a monkey-patchable factory.
import { createProvider } from "./index.js";

test("returns Claude-only provider when FIREWORKS_API_KEY is unset", async () => {
  let anthropicCalled = false;
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "",
    _anthropicFactory: ({ apiKey }) => ({
      async streamTurn(params, onText) {
        anthropicCalled = true;
        onText?.("hi");
        return { stop_reason: "end_turn", content: [{ type: "text", text: "hi" }] };
      },
    }),
  };
  const provider = createProvider(env);
  const result = await provider.streamTurn({ model: "m", max_tokens: 64, system: [], tools: [], messages: [] }, null);
  assert.ok(anthropicCalled);
  assert.equal(result.stop_reason, "end_turn");
});

test("falls back to Claude when Fireworks throws and FIREWORKS_FALLBACK_ENABLED=true", async () => {
  const calls = [];
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "fw-key",
    FIREWORKS_MODEL: "accounts/fireworks/models/test",
    FIREWORKS_FALLBACK_ENABLED: "true",
    _anthropicFactory: () => ({
      async streamTurn() {
        calls.push("claude");
        return { stop_reason: "end_turn", content: [] };
      },
    }),
    _fireworksFactory: () => ({
      async streamTurn() {
        calls.push("fireworks");
        throw Object.assign(new Error("503 Service Unavailable"), { status: 503 });
      },
    }),
  };
  const provider = createProvider(env);
  await provider.streamTurn({ model: "m", max_tokens: 64, system: [], tools: [], messages: [] }, null);
  assert.deepEqual(calls, ["fireworks", "claude"]);
});

test("throws when Fireworks fails and FIREWORKS_FALLBACK_ENABLED=false", async () => {
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "fw-key",
    FIREWORKS_MODEL: "accounts/fireworks/models/test",
    FIREWORKS_FALLBACK_ENABLED: "false",
    _anthropicFactory: () => ({ async streamTurn() { return { stop_reason: "end_turn", content: [] }; } }),
    _fireworksFactory: () => ({
      async streamTurn() { throw Object.assign(new Error("500"), { status: 500 }); },
    }),
  };
  const provider = createProvider(env);
  await assert.rejects(
    () => provider.streamTurn({ model: "m", max_tokens: 64, system: [], tools: [], messages: [] }, null),
    /500/
  );
});
