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

/**
 * Pick the most natural-sounding installed voice. macOS exposes a mix of old
 * robotic voices and modern premium/Siri ones; getVoices() order is arbitrary,
 * so score by name instead of taking the first English voice.
 */
export function pickBestVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const en = voices.filter(v => /^en/i.test(v.lang))
  if (!en.length) return voices[0]
  const score = (v: SpeechSynthesisVoice): number => {
    const n = v.name.toLowerCase()
    let s = 0
    if (/siri/.test(n)) s += 100
    if (/premium|enhanced|natural|neural/.test(n)) s += 60
    if (/\b(ava|samantha|allison|zoe|evan|tom|nicky|joelle|nathan|serena)\b/.test(n)) s += 30
    if (/en[-_]us/i.test(v.lang)) s += 5
    if (/compact|fred|albert|bad news|bells|bubbles|cellos|whisper|organ|trinoids|zarvox|junior|ralph|kathy|bahh|boing|deranged|hysterical|pipe|wobble/.test(n)) s -= 80
    return s
  }
  return [...en].sort((a, b) => score(b) - score(a))[0]
}

const TTS_URL = (import.meta.env.VITE_TTS_URL as string | undefined) ?? 'http://localhost:8788'

export function createVoiceOutput(): VoiceOutput {
  let controller: AbortController | null = null
  let pending: { onStart: () => void; started: boolean } | null = null

  // Drive the speaking state off the TTS server's real lifecycle: onStart fires
  // when audio actually starts playing (not optimistically during synthesis).
  if (typeof EventSource !== 'undefined') {
    try {
      const es = new EventSource(`${TTS_URL}/events`)
      es.onmessage = m => {
        try {
          const d = JSON.parse(m.data)
          if (d?.type === 'state' && d.state === 'speaking' && pending && !pending.started) {
            pending.started = true
            pending.onStart()
          }
        } catch { /* ignore keep-alives */ }
      }
    } catch { /* ignore */ }
  }

  function webSpeechFallback(clean: string, onStart: () => void, onEnd: () => void) {
    try {
      onStart()
      const utt = new SpeechSynthesisUtterance(clean)
      const best = pickBestVoice(window.speechSynthesis.getVoices())
      if (best) utt.voice = best
      utt.onend = () => onEnd()
      utt.onerror = () => onEnd()
      window.speechSynthesis.speak(utt)
    } catch {
      onStart(); onEnd()
    }
  }

  return {
    speak(text, onStart, onEnd) {
      const clean = toSpokenText(text)
      if (!clean) { onEnd(); return }
      controller?.abort()
      controller = new AbortController()
      pending = { onStart, started: false }
      // Primary: local Kokoro neural TTS. The request blocks until playback
      // finishes, so resolving == speech done (authoritative end transition).
      fetch(`${TTS_URL}/speak`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean }),
      })
        .then(res => {
          if (!res.ok) throw new Error(`tts ${res.status}`)
          pending = null
          onEnd()
        })
        .catch(err => {
          if ((err as Error)?.name === 'AbortError') return
          pending = null
          webSpeechFallback(clean, onStart, onEnd)
        })
    },
    cancel() {
      controller?.abort()
      controller = null
      pending = null
      fetch(`${TTS_URL}/cancel`, { method: 'POST' }).catch(() => {})
      try { window.speechSynthesis.cancel() } catch { /* ignore */ }
    },
  }
}
