// Per-conversation working memory.
//
// The client POSTs the spoken transcript only — never the tool results or drafts
// the agent built mid-turn. That makes the agent "start fresh" after a confirm step
// (it asks "save this?", the user says "yes", but the draft is gone). We fix that
// by caching the enriched Anthropic message list (tool_use/tool_result blocks +
// drafts + final reply) after each turn and restoring it on the next turn.
//
// Single-user, so a one-slot store is enough. We detect whether an incoming request
// continues the cached conversation by content — the incoming history must contain
// the cached turn's last reply.

import { contentToText, cleanSpokenText } from "./translate.js";

const MAX_HISTORY = 60;

let store = null; // { messages: AnthropicMessage[], lastReply: string }

export function __resetConversationStore() {
  store = null;
}

/** Flatten the user message(s) that follow the last assistant turn into one string. */
export function trailingUserContent(openaiMessages) {
  const list = Array.isArray(openaiMessages) ? openaiMessages : [];
  let lastAssistant = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const tail = list
    .slice(lastAssistant + 1)
    .filter((m) => m.role === "user")
    .map((m) => contentToText(m.content))
    .filter(Boolean);
  return tail.join("\n\n");
}

/** True if the incoming spoken history contains the cached turn's last reply. */
export function isContinuation(openaiMessages, lastReply) {
  if (!lastReply) return false;
  const target = cleanSpokenText(lastReply);
  if (!target) return false;
  return (Array.isArray(openaiMessages) ? openaiMessages : []).some(
    (m) => m.role === "assistant" && cleanSpokenText(m.content) === target,
  );
}

/** Keep the most recent messages, starting on a clean user turn (no orphan tool_result). */
export function trimHistory(messages, max = MAX_HISTORY) {
  if (!Array.isArray(messages) || messages.length <= max) return messages?.slice?.() ?? [];
  let start = messages.length - max;
  // Move the boundary BACK to the nearest clean user turn (a plain user message,
  // not a tool_result continuation) so we never strand an orphan tool_result and
  // always start on a user role. Keeping a few extra messages is fine.
  while (start > 0) {
    const m = messages[start];
    const isToolResult =
      Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result");
    if (m.role === "user" && !isToolResult) break;
    start -= 1;
  }
  return messages.slice(start);
}

/** Persist the enriched messages + spoken reply for this conversation. */
export function rememberTurn(messages, reply) {
  store = { messages: trimHistory(messages, MAX_HISTORY), lastReply: reply || "" };
}

/**
 * Decide the message list to run the agent on.
 * - Continuation: cached enriched history + the new (trailing) user turn.
 * - Fresh: the freshly translated messages (caller passes them in).
 * @returns {{ messages: AnthropicMessage[], resumed: boolean }}
 */
export function resumeOrStart(openaiMessages, freshMessages) {
  if (store && isContinuation(openaiMessages, store.lastReply)) {
    const newTurn = trailingUserContent(openaiMessages);
    const messages = store.messages.slice();
    if (newTurn) messages.push({ role: "user", content: newTurn });
    return { messages, resumed: true };
  }
  return { messages: freshMessages.slice(), resumed: false };
}
