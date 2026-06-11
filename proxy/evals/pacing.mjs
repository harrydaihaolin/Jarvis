// Autonomous eval: real-time pacing.
//
// The agent should speak a brief acknowledgement ("On it, one sec…") BEFORE its
// first tool call, so in voice mode the user isn't met with silence while it
// works. We drive runAgent directly on tool-triggering prompts and assert that
// non-trivial spoken text arrives before the first tool call, and that an LLM
// judge agrees it's an acknowledgement (not the actual answer).
//
// Run: npm run evals   (needs ANTHROPIC_API_KEY; makes real Claude calls)

import dotenv from "dotenv";
dotenv.config({ path: new URL("../../.env", import.meta.url).pathname });

import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "../src/agent.js";
import { createProvider } from "../src/providers/index.js";
import { openaiToAnthropic } from "../src/translate.js";

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY is not set — copy .env and fill it in.");
  process.exit(2);
}
const anthropic = new Anthropic({ apiKey: KEY });
const provider = createProvider(process.env);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

// Tool set: web_search on (the thing that triggers a tool turn), no commands/memory.
const cfg = { webSearch: true, webSearchMaxUses: 3, enableCommands: false, maxIterations: 6 };

// Prompts that should require a tool (current info → web_search).
const SCENARIOS = [
  { name: "current weather", input: "What's the current weather in Tokyo right now?" },
  { name: "today's news", input: "What's one top news headline from today?" },
];

// The first spoken sentence is what the user hears first (the streaming chunker
// speaks it immediately), so that's what we evaluate for pacing.
function firstSentence(text) {
  // Mirror the frontend chunker: a sentence ends at . ! ? followed by whitespace,
  // a capital, or a quote (the model drops the space across content blocks).
  const m = text.match(/^[\s\S]*?[.!?]+(?=\s|["'A-Z]|$)/);
  const s = m ? m[0] : (text.split("\n")[0] || text);
  return s.replace(/<emotion\b[^>]*\/?>/gi, " ").trim();
}

async function runTurn(userText) {
  const baseParams = openaiToAnthropic(
    { model: MODEL, messages: [{ role: "user", content: userText }] },
    { defaultModel: MODEL, defaultMaxTokens: 1024 },
  );
  let fullText = "";
  const toolCalls = [];
  await runAgent({
    provider,
    baseParams,
    cfg,
    onText: (d) => { fullText += d; },
    onEvent: (e) => { if (e.type === "tool_call") toolCalls.push(e.name); },
  });
  return { firstSentence: firstSentence(fullText), toolCalls };
}

async function judge(question, text) {
  const r = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 200,
    system:
      'You are a strict evaluator. Reply with ONLY a JSON object: {"pass": boolean, "reason": "<short>"}.',
    messages: [{ role: "user", content: `${question}\n\nTEXT:\n"""${text}"""` }],
  });
  const out = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  try {
    return JSON.parse(out.match(/\{[\s\S]*\}/)[0]);
  } catch {
    return { pass: false, reason: "judge parse error: " + out.slice(0, 120) };
  }
}

let failures = 0;
function check(name, pass, detail) {
  console.log(`   ${pass ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
  if (!pass) failures++;
}

console.log("Eval: real-time pacing (agent speaks before its first tool call)\n");
for (const s of SCENARIOS) {
  console.log(`▶ ${s.name}: "${s.input}"`);
  let first, toolCalls;
  try {
    ({ firstSentence: first, toolCalls } = await runTurn(s.input));
  } catch (e) {
    check("agent turn completed", false, String(e?.message || e));
    continue;
  }
  check("used a tool", toolCalls.length > 0, `tools: ${toolCalls.join(", ") || "none"}`);
  check("first spoken sentence exists", first.length > 0, `first: ${JSON.stringify(first.slice(0, 90))}`);
  check("first sentence is brief (< 140 chars)", first.length > 0 && first.length < 140, `len=${first.length}`);
  if (first) {
    const j = await judge(
      "Is the following the assistant's brief spoken acknowledgement that it is STARTING to work on the request (e.g. 'On it, give me a sec', 'Let me look that up') — rather than the actual answer/result? pass=true only for a short acknowledgement or status line, pass=false if it already states the answer.",
      first,
    );
    check("judge: first sentence is a pacing acknowledgement", j.pass, j.reason);
  }
  console.log("");
}

console.log(failures === 0 ? "✅ all pacing checks passed" : `❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
