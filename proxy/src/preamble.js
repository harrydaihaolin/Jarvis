// Decoupled preamble: fires a tiny fast model call to generate a spoken
// acknowledgment while the full agent loop starts simultaneously. Preamble
// text reaches the caller first; main loop text follows after preamble completes.

export const PREAMBLE_SYSTEM =
  "Generate a 3–6 word spoken acknowledgment for a voice assistant. " +
  "Output ONLY those words plus a period. Be natural and varied. " +
  'Examples: "On it." "Let me check that." "Sure, one sec." "Looking that up."';

/**
 * Run preamble and main agent loop concurrently.
 * Preamble text is delivered to onText first; main loop text follows after preamble completes.
 *
 * @param {object}      opts
 * @param {object|null} opts.preambleProvider  provider.streamTurn — null skips preamble
 * @param {string}      opts.userText          spoken user message — empty string skips preamble
 * @param {Function}    opts.runMain           async (onText) => { finishReason, messages, iterations }
 * @param {Function}    opts.onText            (delta: string) => void
 * @returns {Promise<{ finishReason: string, messages: object[], iterations: number }>}
 */
export async function runWithPreamble({ preambleProvider, userText, runMain, onText }) {
  if (!preambleProvider || !userText?.trim()) {
    return runMain(onText);
  }

  const mainBuffer = [];
  let preambleDone = false;

  // Start preamble: streams directly to the caller's onText.
  const preambleTask = preambleProvider
    .streamTurn(
      {
        system: [{ type: "text", text: PREAMBLE_SYSTEM }],
        messages: [{ role: "user", content: userText }],
        max_tokens: 20,
        tools: [],
      },
      (delta) => onText(delta),
    )
    .catch((err) => console.error(`[preamble] failed: ${err.message}`));

  // Start main loop concurrently: buffer its text until preamble completes.
  const mainResultPromise = runMain((delta) => {
    if (preambleDone) onText(delta);
    else mainBuffer.push(delta);
  });

  // Wait for preamble, then flush buffered main text and enable live streaming.
  await preambleTask;
  preambleDone = true;
  for (const d of mainBuffer) onText(d);
  mainBuffer.length = 0;

  return mainResultPromise;
}
