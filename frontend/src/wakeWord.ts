// "Hey Jarvis" wake-phrase detection over STT transcripts.
//
// Two tiers keep recall high without false wakes:
// - CORE variants (Jarvis + close mishears that aren't real words/names) wake
//   bare, anywhere in the utterance: "Jarvis, lights on" works.
// - LOOSE variants (mishears that collide with real names, e.g. "Travis") only
//   wake when preceded by hey/hi/ok, so "I told Travis about it" is ignored
//   but "Hey Travis, what's the weather" still wakes.

const CORE = 'jarvis|jarvus|jervis|javis|jarvas|jarves|jarviss|garvis|harvis|darvis|charvis'
const LOOSE = 'travis|tarvis|davis|marvis|harvest'
const PREFIX = '(?:hey|hi|ok|okay)[\\s,]+'
const TRAIL = '[\\s,.:!?-]*'

const PREFIXED_RE = new RegExp(`\\b${PREFIX}(?:${CORE}|${LOOSE})\\b${TRAIL}`, 'i')
const BARE_RE = new RegExp(`\\b(?:${CORE})\\b${TRAIL}`, 'i')

/**
 * Match the wake phrase in an utterance. Returns the command after the wake
 * phrase ('' if the wake phrase ends the utterance), or null if no wake.
 * "Hey Jarvis, what's the weather" → "what's the weather".
 */
export function matchWake(text: string): string | null {
  for (const re of [PREFIXED_RE, BARE_RE]) {
    const m = text.match(re)
    if (m) return text.slice((m.index ?? 0) + m[0].length).trim()
  }
  return null
}
