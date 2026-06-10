export function stripEmotionTags(text: string): string {
  return text
    .replace(/<emotion\b[^>]*\/?>/gi, ' ')
    .replace(/<\/emotion>/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const SPEAK_MAX = 600 // chars before we summarize aloud (full text stays in the console)

/**
 * What Jarvis actually says out loud. The agent console shows the full reply;
 * this strips big content dumps (code blocks, long output) so he doesn't read
 * pages aloud — he gives the lead-in and points to the screen instead.
 */
export function toSpokenText(raw: string): string {
  let t = stripEmotionTags(raw)
  // Never read fenced code/content blocks aloud.
  t = t.replace(/```[\s\S]*?```/g, ' — I’ve put that on the screen. ')
  // Long replies: speak the lead-in up to a sentence boundary, then defer.
  if (t.length > SPEAK_MAX) {
    const head = t.slice(0, SPEAK_MAX)
    const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
    const lead = cut > 120 ? head.slice(0, cut + 1) : head
    t = `${lead.trim()} I’ve put the full details on the screen.`
  }
  return t.replace(/\s+/g, ' ').trim()
}

export interface VoiceOutput {
  speak(text: string, onStart: () => void, onEnd: () => void): void
  cancel(): void
}

export function createVoiceOutput(): VoiceOutput {
  return {
    speak(text, onStart, onEnd) {
      window.speechSynthesis.cancel()
      const clean = toSpokenText(text)
      if (!clean) { onEnd(); return }

      const utt = new SpeechSynthesisUtterance(clean)
      const voices = window.speechSynthesis.getVoices()
      const en = voices.find(v => v.lang.startsWith('en'))
      if (en) utt.voice = en

      utt.onstart = onStart
      utt.onend = () => onEnd()
      utt.onerror = () => onEnd()
      window.speechSynthesis.speak(utt)
    },
    cancel() {
      window.speechSynthesis.cancel()
    },
  }
}
