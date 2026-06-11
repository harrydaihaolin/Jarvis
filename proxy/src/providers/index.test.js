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

test("does not fall back after partial text was emitted (avoids double-speak)", async () => {
  const calls = [];
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "fw-key",
    FIREWORKS_FALLBACK_ENABLED: "true",
    _anthropicFactory: () => ({
      async streamTurn() { calls.push("claude"); return { stop_reason: "end_turn", content: [] }; },
    }),
    _fireworksFactory: () => ({
      async streamTurn(_params, onText) {
        onText?.("partial ");
        calls.push("fireworks");
        throw Object.assign(new Error("stream aborted"), { status: 0 });
      },
    }),
  };
  const provider = createProvider(env);
  const received = [];
  await assert.rejects(
    () => provider.streamTurn({ model: "m", max_tokens: 64, system: [], tools: [], messages: [] }, (d) => received.push(d)),
    /stream aborted/
  );
  assert.deepEqual(calls, ["fireworks"]);
  assert.deepEqual(received, ["partial "]);
});

test("throws at creation when fallback enabled without ANTHROPIC_API_KEY", () => {
  assert.throws(
    () => createProvider({ ANTHROPIC_API_KEY: "", FIREWORKS_API_KEY: "fw-key", FIREWORKS_FALLBACK_ENABLED: "true", _anthropicFactory: () => ({}), _fireworksFactory: () => ({}) }),
    /requires ANTHROPIC_API_KEY/
  );
});

test("fallback call uses ANTHROPIC_MODEL instead of the request model", async () => {
  let claudeModel = null;
  const env = {
    ANTHROPIC_API_KEY: "ant-key",
    ANTHROPIC_MODEL: "claude-test-model",
    FIREWORKS_API_KEY: "fw-key",
    FIREWORKS_FALLBACK_ENABLED: "true",
    _anthropicFactory: () => ({
      async streamTurn(params) { claudeModel = params.model; return { stop_reason: "end_turn", content: [] }; },
    }),
    _fireworksFactory: () => ({
      async streamTurn() { throw Object.assign(new Error("503"), { status: 503 }); },
    }),
  };
  const provider = createProvider(env);
  await provider.streamTurn({ model: "junk-model", max_tokens: 64, system: [], tools: [], messages: [] }, null);
  assert.equal(claudeModel, "claude-test-model");
});

test("passes reasoning_effort extraBody to the fireworks factory", () => {
  let fwArgs = null;
  createProvider({
    ANTHROPIC_API_KEY: "ant-key",
    FIREWORKS_API_KEY: "fw-key",
    FIREWORKS_MODEL: "m",
    FIREWORKS_REASONING_EFFORT: "low",
    _anthropicFactory: () => ({}),
    _fireworksFactory: (args) => { fwArgs = args; return {}; },
  });
  assert.deepEqual(fwArgs.extraBody, { reasoning_effort: "low" });
});
