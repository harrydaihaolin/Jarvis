import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentToText,
  openaiToAnthropic,
  mapFinishReason,
  streamChunk,
  cleanSpokenText,
  lastSpokenUserText,
} from "./translate.js";

const opts = { defaultModel: "claude-sonnet-4-6", defaultMaxTokens: 1024 };

test("contentToText handles string and array parts", () => {
  assert.equal(contentToText("hello"), "hello");
  assert.equal(contentToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(contentToText(null), "");
});

test("hoists system messages into top-level system", () => {
  const out = openaiToAnthropic(
    { messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }] },
    opts,
  );
  assert.equal(out.system, "be nice");
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
});

test("merges consecutive same-role turns", () => {
  const out = openaiToAnthropic(
    {
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
        { role: "assistant", content: "ok" },
      ],
    },
    opts,
  );
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].content, "one\n\ntwo");
  assert.equal(out.messages[1].role, "assistant");
});

test("forces conversation to start with a user turn", () => {
  const out = openaiToAnthropic({ messages: [{ role: "assistant", content: "hello there" }] }, opts);
  assert.equal(out.messages[0].role, "user");
  assert.equal(out.messages[1].role, "assistant");
});

test("ignores Tavus pseudo-model names and falls back to default", () => {
  const out = openaiToAnthropic({ model: "tavus-claude-haiku-4.5", messages: [{ role: "user", content: "x" }] }, opts);
  assert.equal(out.model, "claude-sonnet-4-6");
  const out2 = openaiToAnthropic({ model: "claude-opus-4-8", messages: [{ role: "user", content: "x" }] }, opts);
  assert.equal(out2.model, "claude-opus-4-8");
});

test("clamps max_tokens", () => {
  assert.equal(openaiToAnthropic({ messages: [], max_tokens: 0 }, opts).max_tokens, 1);
  assert.equal(openaiToAnthropic({ messages: [], max_tokens: 99999 }, opts).max_tokens, 8192);
  assert.equal(openaiToAnthropic({ messages: [] }, opts).max_tokens, 1024);
});

test("mapFinishReason maps anthropic stop reasons", () => {
  assert.equal(mapFinishReason("end_turn"), "stop");
  assert.equal(mapFinishReason("max_tokens"), "length");
});

test("cleanSpokenText strips a user_audio_analysis prefix, keeping the speech", () => {
  const raw =
    "<user_audio_analysis>\nThe speaker sounds bored and slightly annoyed.\n</user_audio_analysis>\nBanana telephone, what is two plus two?";
  assert.equal(cleanSpokenText(raw), "Banana telephone, what is two plus two?");
});

test("cleanSpokenText drops pure perception/instruction blocks", () => {
  assert.equal(
    cleanSpokenText("<additional_system_instructions><user_appearance>\nAn Asian male in his 30s.\n</user_appearance></additional_system_instructions>"),
    "",
  );
  assert.equal(cleanSpokenText("<additional_system_instructions>respond in english</additional_system_instructions>"), "");
  assert.equal(cleanSpokenText("<user_emotions>\nappears contemplative\n</user_emotions>"), "");
});

test("cleanSpokenText removes inline <emotion> tags from assistant text", () => {
  assert.equal(
    cleanSpokenText('<emotion value="excited"/> Sure thing.<emotion value="neutral"/> Two plus two is four!'),
    "Sure thing. Two plus two is four!",
  );
});

test("cleanSpokenText passes through plain speech unchanged", () => {
  assert.equal(cleanSpokenText("Hey, how are you?"), "Hey, how are you?");
});

test("lastSpokenUserText returns the latest real utterance, skipping perception-only turns", () => {
  const messages = [
    { role: "user", content: "Hey, how are you?" },
    { role: "assistant", content: "Doing great!" },
    { role: "user", content: "<additional_system_instructions>respond in english</additional_system_instructions>" },
    { role: "user", content: "<user_audio_analysis>\ndry tone\n</user_audio_analysis>\nSummarize this for me." },
  ];
  assert.equal(lastSpokenUserText(messages), "Summarize this for me.");
});

test("streamChunk has OpenAI chunk shape", () => {
  const c = streamChunk({ id: "x", created: 1, model: "m", delta: { content: "hi" } });
  assert.equal(c.object, "chat.completion.chunk");
  assert.equal(c.choices[0].delta.content, "hi");
  assert.equal(c.choices[0].finish_reason, null);
});
