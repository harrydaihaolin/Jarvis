import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithPreamble } from "./preamble.js";

test("preamble text arrives before main text", async () => {
  const received = [];
  const preambleProvider = {
    async streamTurn(_params, onText) {
      onText("On it.");
      return { stop_reason: "end_turn", content: [] };
    },
  };
  await runWithPreamble({
    preambleProvider,
    userText: "hello",
    runMain: async (onText) => {
      onText("Hello there!");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["On it.", "Hello there!"]);
});

test("preamble failure does not block main text", async () => {
  const received = [];
  const preambleProvider = {
    async streamTurn() {
      throw new Error("network error");
    },
  };
  await runWithPreamble({
    preambleProvider,
    userText: "hello",
    runMain: async (onText) => {
      onText("Still here!");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["Still here!"]);
});

test("skips preamble when userText is empty", async () => {
  const received = [];
  const preambleProvider = {
    async streamTurn(_p, onText) {
      onText("On it.");
      return {};
    },
  };
  await runWithPreamble({
    preambleProvider,
    userText: "",
    runMain: async (onText) => {
      onText("Response.");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["Response."]);
});

test("skips preamble when preambleProvider is null", async () => {
  const received = [];
  await runWithPreamble({
    preambleProvider: null,
    userText: "hello",
    runMain: async (onText) => {
      onText("Response.");
      return { finishReason: "stop", messages: [], iterations: 1 };
    },
    onText: (d) => received.push(d),
  });
  assert.deepEqual(received, ["Response."]);
});
