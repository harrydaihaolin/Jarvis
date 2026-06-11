import { test } from "node:test";
import assert from "node:assert/strict";
import { appendMemoryBlock } from "./memory.js";

test("appendMemoryBlock appends block to existing system", () => {
  const result = appendMemoryBlock("You are Jarvis.", "User is Alice.");
  assert.equal(result, "You are Jarvis.\n\n<memory>\nUser is Alice.\n</memory>");
});

test("appendMemoryBlock returns system unchanged when memText is blank", () => {
  assert.equal(appendMemoryBlock("You are Jarvis.", ""), "You are Jarvis.");
  assert.equal(appendMemoryBlock("You are Jarvis.", "   "), "You are Jarvis.");
  assert.equal(appendMemoryBlock("You are Jarvis.", null), "You are Jarvis.");
});

test("appendMemoryBlock handles empty system string", () => {
  const result = appendMemoryBlock("", "User is Alice.");
  assert.equal(result, "<memory>\nUser is Alice.\n</memory>");
});

test("appendMemoryBlock trims whitespace from memText", () => {
  const result = appendMemoryBlock("Base.", "  context  ");
  assert.ok(result.includes("<memory>\ncontext\n</memory>"));
});
