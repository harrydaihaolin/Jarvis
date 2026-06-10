import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trailingUserContent,
  isContinuation,
  trimHistory,
  rememberTurn,
  resumeOrStart,
  __resetConversationStore,
} from "./conversation.js";

test("trailingUserContent merges the user messages after the last assistant turn", () => {
  const messages = [
    { role: "user", content: "Hey" },
    { role: "assistant", content: "Hi! What's up?" },
    { role: "user", content: "<user_audio_analysis>dry tone</user_audio_analysis>" },
    { role: "user", content: "Save my notes please" },
  ];
  assert.equal(
    trailingUserContent(messages),
    "<user_audio_analysis>dry tone</user_audio_analysis>\n\nSave my notes please",
  );
});

test("trailingUserContent returns the whole thing when there is no assistant turn", () => {
  const messages = [{ role: "user", content: "first" }];
  assert.equal(trailingUserContent(messages), "first");
});

test("isContinuation matches when the incoming history contains the last spoken reply", () => {
  const incoming = [
    { role: "user", content: "Hey" },
    { role: "assistant", content: '<emotion value="content"/> Doing great!' },
    { role: "user", content: "Save it" },
  ];
  assert.equal(isContinuation(incoming, "Doing great!"), true);
  assert.equal(isContinuation(incoming, "Something else entirely"), false);
  assert.equal(isContinuation(incoming, null), false);
});

test("trimHistory keeps recent messages and starts on a user turn", () => {
  const msgs = [];
  for (let i = 0; i < 50; i++) {
    msgs.push({ role: "user", content: `u${i}` });
    msgs.push({ role: "assistant", content: `a${i}` });
  }
  const trimmed = trimHistory(msgs, 10);
  assert.ok(trimmed.length <= 10);
  assert.equal(trimmed[0].role, "user");
  // Most recent turn is preserved.
  assert.equal(trimmed[trimmed.length - 1].content, "a49");
});

test("trimHistory never strands a tool_result as the first message", () => {
  const msgs = [
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "assistant", content: "done" },
  ];
  const trimmed = trimHistory(msgs, 2);
  assert.equal(trimmed[0].role, "user");
  const first = trimmed[0].content;
  const isToolResult = Array.isArray(first) && first.some((b) => b.type === "tool_result");
  assert.equal(isToolResult, false);
});

test("resumeOrStart: fresh conversation uses incoming messages; continuation reuses cached + new turn", () => {
  __resetConversationStore();

  // Turn 1 (fresh): user opens.
  const incoming1 = [
    { role: "system", content: "You are Jarvus." },
    { role: "user", content: "Summarize the moon landing" },
  ];
  const start = resumeOrStart(incoming1, [
    { role: "user", content: "Summarize the moon landing" },
  ]);
  assert.equal(start.resumed, false);
  assert.equal(start.messages[start.messages.length - 1].content, "Summarize the moon landing");

  // Persist the enriched turn 1 (with a draft the model produced + its reply).
  rememberTurn(
    [
      { role: "user", content: "Summarize the moon landing" },
      { role: "assistant", content: "Here's a draft: Apollo 11 landed in 1969. Save it?" },
    ],
    "Here's a draft: Apollo 11 landed in 1969. Save it?",
  );

  // Turn 2 (continuation): Tavus carries the spoken history + the new "yes".
  const incoming2 = [
    { role: "system", content: "You are Jarvus." },
    { role: "user", content: "Summarize the moon landing" },
    { role: "assistant", content: "Here's a draft: Apollo 11 landed in 1969. Save it?" },
    { role: "user", content: "Yes, save it" },
  ];
  const resume = resumeOrStart(incoming2, [{ role: "user", content: "ignored translated" }]);
  assert.equal(resume.resumed, true);
  // The cached draft is still present in context...
  const text = JSON.stringify(resume.messages);
  assert.ok(text.includes("Apollo 11 landed in 1969"));
  // ...and the new user turn is appended last.
  assert.equal(resume.messages[resume.messages.length - 1].role, "user");
  assert.ok(resume.messages[resume.messages.length - 1].content.includes("Yes, save it"));
});
