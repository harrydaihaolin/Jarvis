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

  const claude = _anthropicFactory({ apiKey: ANTHROPIC_API_KEY });

  if (!FIREWORKS_API_KEY) return claude;

  const fireworks = _fireworksFactory({ apiKey: FIREWORKS_API_KEY, model: FIREWORKS_MODEL });
  const fallbackEnabled = FIREWORKS_FALLBACK_ENABLED !== "false";

  return {
    async streamTurn(params, onText) {
      try {
        return await fireworks.streamTurn(params, onText);
      } catch (err) {
        if (!fallbackEnabled) throw err;
        console.error(`[provider] Fireworks failed (${err.message}), falling back to Claude`);
        return claude.streamTurn(params, onText);
      }
    },
  };
}
