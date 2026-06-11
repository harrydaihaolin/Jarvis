// Decoupled preamble: fires a tiny fast model call to generate a spoken
// acknowledgment while the full agent loop starts simultaneously. Preamble
// text reaches the caller first; main loop text follows after preamble completes.

export const PREAMBLE_SYSTEM =
  "You write short spoken acknowledgments for a voice assistant. " +
  "Given a user request, output ONLY a 3\u20136 word acknowledgment plus a period \u2014 never answer the request itself. " +
  'Be natural and varied. Examples: "On it." "Let me check that." "Sure, one sec." "Looking that up."';

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
        messages: [{ role: "user", content: `The user said: ${JSON.stringify(userText)} \u2014 output only the acknowledgment.` }],
        max_tokens: 60,
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

  // Wait for the preamble — or a main-loop failure, whichever comes first.
  // mainFailure never settles on success, so ordering is preserved; attaching
  // the catch also prevents an unhandled rejection during the preamble wait.
  const mainFailure = new Promise((resolve) => {
    mainResultPromise.catch(resolve);
  });
  await Promise.race([preambleTask, mainFailure]);
  preambleDone = true;
  for (const d of mainBuffer) onText(d);
  mainBuffer.length = 0;

  return mainResultPromise;
}
