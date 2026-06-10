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

export interface SpeechStream {
  push(text: string): void
  done(): void
}

export interface VoiceOutput {
  /** Speak a single block (convenience: one chunk then done). */
  speak(text: string, onStart: () => void, onEnd: () => void): void
  /** Stream speech: push sentences as they arrive, call done() when the source ends. */
  speakStream(onStart: () => void, onDone: () => void): SpeechStream
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
  let queue: string[] = []
  let playing = false
  let ended = false
  let started = false
  let onStartCb: (() => void) | null = null
  let onDoneCb: (() => void) | null = null
  let abort: AbortController | null = null

  // onStart fires when audio actually begins (the server's real 'speaking' event),
  // not optimistically during synthesis.
  if (typeof EventSource !== 'undefined') {
    try {
      const es = new EventSource(`${TTS_URL}/events`)
      es.onmessage = m => {
        try {
          const d = JSON.parse(m.data)
          if (d?.type === 'state' && d.state === 'speaking' && onStartCb && !started) {
            started = true
            onStartCb()
          }
        } catch { /* ignore keep-alives */ }
      }
    } catch { /* ignore */ }
  }

  function fireStart() {
    if (onStartCb && !started) { started = true; onStartCb() }
  }

  function webSpeechChunk(text: string): Promise<void> {
    return new Promise(resolve => {
      try {
        fireStart()
        const utt = new SpeechSynthesisUtterance(text)
        const best = pickBestVoice(window.speechSynthesis.getVoices())
        if (best) utt.voice = best
        utt.onend = () => resolve()
        utt.onerror = () => resolve()
        window.speechSynthesis.speak(utt)
      } catch {
        resolve()
      }
    })
  }

  async function pump() {
    if (playing) return
    playing = true
    while (queue.length) {
      const text = queue.shift() as string
      abort = new AbortController()
      try {
        // Kokoro: the request blocks until this chunk finishes playing.
        const res = await fetch(`${TTS_URL}/speak`, {
          method: 'POST',
          signal: abort.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
        if (!res.ok) throw new Error(`tts ${res.status}`)
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') { playing = false; return }
        await webSpeechChunk(text) // server unreachable → system voice
      }
    }
    playing = false
    if (ended) {
      const cb = onDoneCb
      onStartCb = null
      onDoneCb = null
      cb?.()
    }
  }

  function speakStream(onStart: () => void, onDone: () => void): SpeechStream {
    queue = []
    started = false
    ended = false
    onStartCb = onStart
    onDoneCb = onDone
    return {
      push(text: string) {
        const t = (text || '').trim()
        if (t) { queue.push(t); void pump() }
      },
      done() { ended = true; void pump() },
    }
  }

  return {
    speakStream,
    speak(text, onStart, onEnd) {
      const stream = speakStream(onStart, onEnd)
      const clean = toSpokenText(text)
      if (clean) stream.push(clean)
      stream.done()
    },
    cancel() {
      queue = []
      ended = true
      started = false
      onStartCb = null
      onDoneCb = null
      abort?.abort()
      fetch(`${TTS_URL}/cancel`, { method: 'POST' }).catch(() => {})
      try { window.speechSynthesis.cancel() } catch { /* ignore */ }
    },
  }
}
