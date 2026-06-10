/**
 * Decide whether an incoming partial transcript should interrupt Jarvis.
 *
 * We only barge in while a turn is in progress (busy) and the transcript is
 * substantial — the minimum length filters any residual echo the hardware
 * echo-cancellation didn't fully remove while Jarvis was speaking.
 */
export function shouldBargeIn(busy: boolean, partial: string, minChars = 3): boolean {
  return busy && partial.trim().length >= minChars
}

/** Lowercased word tokens of a string (for echo matching). */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
}

/**
 * Without hardware echo cancellation, the mic picks up Jarvis's own voice while
 * he speaks. Treat a transcript as echo (not a real interruption) when most of
 * its words are ones Jarvis is currently saying.
 */
export function isLikelyEcho(transcript: string, spokenWords: Set<string>, threshold = 0.6): boolean {
  const words = wordsOf(transcript)
  if (words.length === 0) return true
  const matched = words.filter(w => spokenWords.has(w)).length
  return matched / words.length >= threshold
}
