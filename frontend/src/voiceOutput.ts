export function stripEmotionTags(text: string): string {
  return text
    .replace(/<emotion\b[^>]*\/?>/gi, ' ')
    .replace(/<\/emotion>/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface VoiceOutput {
  speak(text: string, onStart: () => void, onEnd: () => void): void
  cancel(): void
}

export function createVoiceOutput(): VoiceOutput {
  return {
    speak(text, onStart, onEnd) {
      window.speechSynthesis.cancel()
      const clean = stripEmotionTags(text)
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
