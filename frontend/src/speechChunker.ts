import { stripEmotionTags, stripMarkdown } from './voiceOutput'

const SCREEN_NOTE = 'I’ve put that on the screen.'

/**
 * Splits a streamed reply into speakable sentences as text arrives, so Jarvis can
 * start talking before the whole answer is ready. Strips `<emotion>` tags and does
 * not read fenced code blocks aloud (emits a short "on screen" note instead — the
 * full text still shows in the console).
 *
 * Usage: feed deltas to push() (returns any sentences now complete); call flush()
 * at the end for whatever's left.
 */
export function createSpeechChunker() {
  let buf = ''
  let inFence = false

  // A sentence ends at . ! ? followed by whitespace OR (when the model drops the
  // space across content blocks, e.g. "right now!Got the results!") a capital
  // letter or quote, or at a newline.
  const SENT = /[.!?]+(?=\s|["'A-Z])|\n/

  function clean(s: string): string {
    return stripMarkdown(stripEmotionTags(s)).trim()
  }

  function drain(final: boolean): string[] {
    const out: string[] = []
    // Loop until we can't make progress without more input.
    for (;;) {
      if (inFence) {
        const close = buf.indexOf('```')
        if (close === -1) {
          if (final) { inFence = false; buf = ''; out.push(SCREEN_NOTE) }
          return out
        }
        buf = buf.slice(close + 3)
        inFence = false
        out.push(SCREEN_NOTE)
        continue
      }
      const open = buf.indexOf('```')
      const m = SENT.exec(buf)
      const sentEnd = m ? m.index + m[0].length : -1

      if (open !== -1 && (sentEnd === -1 || open < sentEnd)) {
        const before = clean(buf.slice(0, open))
        if (before) out.push(before)
        buf = buf.slice(open + 3)
        inFence = true
        continue
      }
      if (sentEnd !== -1) {
        const sentence = clean(buf.slice(0, sentEnd))
        if (sentence) out.push(sentence)
        buf = buf.slice(sentEnd)
        continue
      }
      // No complete sentence and no fence yet.
      if (final) {
        const rest = clean(buf)
        if (rest) out.push(rest)
        buf = ''
      }
      return out
    }
  }

  return {
    push(delta: string): string[] {
      buf += delta
      return drain(false)
    },
    flush(): string[] {
      return drain(true)
    },
  }
}
