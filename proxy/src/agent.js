// The agent runtime: runs Claude's tool-use loop server-side and streams the
// final spoken text out via onText(). Tavus sees one continuous streaming
// completion; the tool round-trips happen invisibly within the turn.

import { buildToolDefs, executeTool } from "./tools/index.js";
import { memoryRecall, memoryRead, memorySave } from "./memory.js";
import { mapFinishReason } from "./translate.js";

const AGENT_ADDENDUM = `

# Operating as a real-time VIDEO AGENT
You are speaking out loud in a live video call, and you can take real actions with tools.

Style:
- Be concise and conversational — your words are spoken aloud. Avoid markdown, lists, and long monologues.
- Before any tool call that may take a moment (web search, running a command), say a short out-loud line first like "Let me look that up" so the user isn't met with silence.

Doing work:
- Reading and searching (web_search, read_file, list_dir, search_files) are safe — use them freely.
- Anything that CHANGES state (write_file, edit_file, run_command) requires explicit confirmation:
  first say exactly what you will do, ask the user to confirm out loud, and only after they say yes
  call the tool with user_confirmed=true. Never set user_confirmed=true unless the user actually agreed.
- All files live in a sandboxed workspace; refer to paths relatively (e.g. "notes.md").
- After acting, briefly confirm what you did.

Long-term memory (persists across conversations):
- At the START of a conversation, call memory_recall to remember who you're talking to, their
  preferences, and any ongoing projects — then greet them with that context.
- When you learn something durable — the user's name, preferences, decisions, ongoing work — call
  memory_save so you remember it next time. Use clear paths like /profile/owner.md or /projects/x.md.
- Memory is your own brain; you don't need to ask permission to read or update it.

Showing things on screen:
- The user has a side console that shows this conversation, your tool activity, and media.
- When something is better seen than described — a picture, screenshot, chart, diagram, or a video/page
  you found — call show_media with a direct URL so it appears in their console. Keep talking naturally;
  show_media displays silently. Don't paste raw URLs into your spoken reply; show them instead.`;

function buildSystem(userSystem, cfg) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const dateLine = `\n\nToday's date is ${today}. Use it when reasoning about current events and web searches.`;
  const text = `${userSystem || "You are a helpful video agent powered by Claude."}${AGENT_ADDENDUM}${dateLine}`;
  // Prompt-cache the (static) system prefix across turns.
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

function withToolCache(tools) {
  if (!tools.length) return tools;
  // Mark the last tool as a cache breakpoint so all tool defs (incl. the
  // web_search server tool) are cached across turns.
  const copy = tools.map((t) => ({ ...t }));
  copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: { type: "ephemeral" } };
  return copy;
}

/**
 * Run the tool-use loop.
 * @param {object} a
 * @param {import('@anthropic-ai/sdk').Anthropic} a.anthropic
 * @param {object} a.baseParams   - from openaiToAnthropic(): { model, max_tokens, messages, system?, temperature? }
 * @param {object} a.cfg          - { webSearch, webSearchMaxUses, enableCommands, maxIterations }
 * @param {(text:string)=>void} a.onText - receives streamed assistant text deltas
 * @param {(evt:object)=>void} [a.onEvent] - optional observability hook for tool steps
 * @returns {Promise<{finishReason:string, iterations:number}>}
 */
export async function runAgent({ anthropic, baseParams, cfg, env = process.env, onText, onEvent }) {
  const tools = withToolCache(buildToolDefs(cfg));
  const system = buildSystem(baseParams.system, cfg);
  const messages = baseParams.messages.slice();
  const maxIterations = cfg.maxIterations ?? 8;

  let finishReason = "stop";
  let iterations = 0;

  for (let i = 0; i < maxIterations; i++) {
    iterations = i + 1;
    const stream = anthropic.messages.stream({
      model: baseParams.model,
      max_tokens: baseParams.max_tokens,
      ...(typeof baseParams.temperature === "number" ? { temperature: baseParams.temperature } : {}),
      system,
      tools,
      messages,
    });

    if (onText) stream.on("text", (delta) => onText(delta));

    const final = await stream.finalMessage();
    const stop = final.stop_reason;

    // Surface web_search activity + citations to the console (server tool runs inline).
    for (const b of final.content) {
      if (b.type === "server_tool_use" && b.name === "web_search") {
        onEvent?.({ type: "tool_call", name: "web_search", input: b.input });
      }
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        const items = b.content
          .filter((r) => r.type === "web_search_result")
          .map((r) => ({ url: r.url, title: r.title }));
        if (items.length) onEvent?.({ type: "citation", items });
      }
    }

    // Server tool (web_search) ran but Claude paused to continue this turn.
    if (stop === "pause_turn") {
      messages.push({ role: "assistant", content: final.content });
      continue;
    }

    // Client tools were requested: execute ours, return tool_results, loop.
    if (stop === "tool_use") {
      const toolUses = final.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) {
        // Only server tools in this turn; nothing for us to answer.
        finishReason = "stop";
        break;
      }
      messages.push({ role: "assistant", content: final.content });
      const results = [];
      for (const b of toolUses) {
        // Long-term memory tools (backed by the managed memory store).
        if (cfg.memory && (b.name === "memory_recall" || b.name === "memory_read" || b.name === "memory_save")) {
          const { anthropic: client, storeId } = cfg.memory;
          let out;
          try {
            if (b.name === "memory_recall") out = await memoryRecall(client, storeId, b.input?.query);
            else if (b.name === "memory_read") out = await memoryRead(client, storeId, b.input?.path);
            else out = await memorySave(client, storeId, b.input?.path, b.input?.content);
          } catch (e) {
            out = `ERROR: ${e.message}`;
          }
          const isErr = typeof out === "string" && out.startsWith("ERROR");
          onEvent?.({ type: "memory", op: b.name.replace("memory_", ""), path: b.input?.path, isError: isErr });
          results.push({ type: "tool_result", tool_use_id: b.id, content: String(out), ...(isErr ? { is_error: true } : {}) });
          continue;
        }

        // Display-only tool: render in the console, don't execute on disk.
        if (b.name === "show_media") {
          onEvent?.({
            type: "media",
            mediaType: b.input?.media_type || "link",
            url: b.input?.url,
            caption: b.input?.caption || "",
          });
          results.push({ type: "tool_result", tool_use_id: b.id, content: "Displayed in the user's console." });
          continue;
        }
        onEvent?.({ type: "tool_call", name: b.name, input: b.input });
        const out = await executeTool(b.name, b.input, { env, cfg });
        const isError = typeof out === "string" && out.startsWith("ERROR");
        onEvent?.({ type: "tool_result", name: b.name, isError });
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: String(out),
          ...(isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: results });
      continue;
    }

    finishReason = mapFinishReason(stop);
    break;
  }

  return { finishReason, iterations };
}
