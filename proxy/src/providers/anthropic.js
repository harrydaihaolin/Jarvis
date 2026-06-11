import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicProvider({ apiKey, _clientOverride }) {
  const client = _clientOverride ?? new Anthropic({ apiKey });
  return {
    async streamTurn({ model, max_tokens, temperature, system, tools, messages }, onText) {
      const stream = client.messages.stream({
        model,
        max_tokens,
        ...(typeof temperature === "number" ? { temperature } : {}),
        system,
        tools,
        messages,
      });
      if (onText) stream.on("text", (delta) => onText(delta));
      return stream.finalMessage();
    },
  };
}
