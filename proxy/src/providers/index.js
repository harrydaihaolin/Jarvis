import { createAnthropicProvider } from "./anthropic.js";
import { createFireworksProvider } from "./fireworks.js";

/**
 * createProvider reads env vars and returns the right provider.
 * Pass _anthropicFactory / _fireworksFactory in env for testing.
 */
export function createProvider(env = process.env) {
  const {
    ANTHROPIC_API_KEY,
    FIREWORKS_API_KEY,
    FIREWORKS_MODEL = "accounts/fireworks/models/llama-v3p3-70b-instruct",
    FIREWORKS_FALLBACK_ENABLED = "true",
    _anthropicFactory = createAnthropicProvider,
    _fireworksFactory = createFireworksProvider,
  } = env;

  const fallbackEnabled = FIREWORKS_FALLBACK_ENABLED !== "false";

  if (FIREWORKS_API_KEY && fallbackEnabled && !ANTHROPIC_API_KEY) {
    throw new Error("FIREWORKS_FALLBACK_ENABLED requires ANTHROPIC_API_KEY to be set");
  }

  const claude = _anthropicFactory({ apiKey: ANTHROPIC_API_KEY });

  if (!FIREWORKS_API_KEY) return claude;

  const fireworks = _fireworksFactory({ apiKey: FIREWORKS_API_KEY, model: FIREWORKS_MODEL });

  return {
    async streamTurn(params, onText) {
      let emitted = false;
      const trackedOnText = onText ? (delta) => { emitted = true; onText(delta); } : onText;
      try {
        return await fireworks.streamTurn(params, trackedOnText);
      } catch (err) {
        if (!fallbackEnabled || emitted) throw err;
        console.error(`[provider] Fireworks failed (${err.message}), falling back to Claude`);
        return claude.streamTurn(params, onText);
      }
    },
  };
}
