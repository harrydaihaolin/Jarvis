import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { JarvisFace, type Emotion } from './components/JarvisFace'
import { AgentConsole } from './AgentConsole'
import { createVoiceOutput } from './voiceOutput'
import { createChatSession } from './chatSession'
import { createSpeechChunker } from './speechChunker'
import { shouldBargeIn, isLikelyEcho, wordsOf } from './bargeIn'

// Diagnosis mode: log the voice pipeline (barge-in, finals) to the dev console.
// On by default; set VITE_DIAGNOSTICS=0 to silence.
const DIAG = (import.meta.env.VITE_DIAGNOSTICS ?? '1') !== '0'
import { openAgentEvents } from './agentEvents'
import './App.css'

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen<T>(event, e => cb(e.payload))
}

async function tauriInvoke(cmd: string): Promise<void> {
  if (!isTauri()) return
  try { await invoke(cmd) } catch { /* ignore */ }
}

// Wake phrase: optional "hey/hi/ok" + "Jarvis" (with common mishears). The text
// after the match becomes the command, so "Hey Jarvis, what's the weather" works.
const WAKE_RE = /\b(?:hey\s+|hi\s+|ok\s+)?(jarvis|jarvus|jervis|travis|tarvis|charvis)\b[\s,.:!?-]*/i

// Seconds of silence in a conversation before dropping back to idle (re-arm wake).
const CONVERSATION_IDLE_MS = 15000

export default function App() {
  const [emotion, setEmotion] = useState<Emotion>('idle')
  const [eyePos, setEyePos] = useState<{ x: number; y: number } | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [active, setActive] = useState(false) // in a conversation (wake heard)
  const [sttHint, setSttHint] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const busyRef = useRef(false)
  const activeRef = useRef(false)
  const micEnabledRef = useRef(true)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Words Jarvis is currently speaking — used to reject mic echo (no AEC).
  const spokenWords = useRef<Set<string>>(new Set())

  const voiceOutput = useMemo(() => createVoiceOutput(), [])
  const chatSession = useMemo(() => createChatSession(), [])

  const setActiveBoth = useCallback((v: boolean) => { setActive(v); activeRef.current = v }, [])

  const resetIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setActiveBoth(false), CONVERSATION_IDLE_MS)
  }, [setActiveBoth])

  // Short "I'm listening" earcon (two ascending tones, no audio asset needed).
  const audioCtx = useRef<AudioContext | null>(null)
  const playChime = useCallback(() => {
    try {
      audioCtx.current ??= new AudioContext()
      const ctx = audioCtx.current
      if (ctx.state === 'suspended') void ctx.resume()
      const now = ctx.currentTime
      ;[[880, 0], [1320, 0.09]].forEach(([freq, at]) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        osc.connect(gain); gain.connect(ctx.destination)
        const t = now + at
        gain.gain.setValueAtTime(0.0001, t)
        gain.gain.exponentialRampToValueAtTime(0.14, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
        osc.start(t); osc.stop(t + 0.2)
      })
    } catch { /* ignore */ }
  }, [])

  // Camera preview (display only)
  useEffect(() => {
    let stream: MediaStream | null = null
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then(s => { stream = s; if (videoRef.current) videoRef.current.srcObject = s })
      .catch(() => { /* permission denied — hide silently */ })
    return () => { stream?.getTracks().forEach(t => t.stop()) }
  }, [])

  // One spoken/typed turn: mic pauses while we think + speak (echo guard), then
  // resumes for the next turn if we're still in a conversation.
  // One turn. The mic stays LIVE throughout (hardware echo cancellation keeps
  // Jarvis from hearing himself), so the user can barge in at any time.
  const sendText = useCallback(async (raw: string) => {
    const text = raw.trim()
    if (!text || busyRef.current) return
    setInput('')
    setBusy(true); busyRef.current = true
    setEmotion('thinking')
    voiceOutput.cancel()
    spokenWords.current = new Set()
    // Don't let the conversation idle-timeout fire mid-turn (a web search can
    // take longer than the timeout).
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null }
    // Mic stays LIVE through the turn (hardware echo cancellation keeps Jarvis
    // from hearing himself) so the user can interrupt at any time.
    const turnDone = () => {
      setBusy(false); busyRef.current = false
      if (activeRef.current) { resetIdleTimer(); playChime() } // your turn
      setEmotion('idle')
    }
    // Stream the reply into speech sentence-by-sentence so the agent's opening
    // pacing line ("On it, one sec…") is spoken immediately while it works, and
    // the voice keeps pace with the text instead of waiting for the whole answer.
    let finished = false
    let watchdog: ReturnType<typeof setTimeout>
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(watchdog)
      turnDone()
    }
    // Backstop only — the real end is the voice stream draining (onDone below).
    watchdog = setTimeout(finish, 180000)
    const chunker = createSpeechChunker()
    const stream = voiceOutput.speakStream(() => setEmotion('speaking'), () => finish())
    try {
      const speak = (sentence: string) => {
        for (const w of wordsOf(sentence)) spokenWords.current.add(w)
        stream.push(sentence)
      }
      await chatSession.send(text, delta => {
        for (const sentence of chunker.push(delta)) speak(sentence)
      })
      for (const sentence of chunker.flush()) speak(sentence)
      stream.done()
    } catch (err) {
      clearTimeout(watchdog)
      if ((err as Error)?.name !== 'AbortError') { voiceOutput.cancel(); turnDone() }
    }
  }, [chatSession, voiceOutput, resetIdleTimer, playChime])

  const sendTextRef = useRef(sendText)
  sendTextRef.current = sendText

  // Start / stop the always-on listener with the mic toggle.
  const toggleMic = useCallback(() => {
    if (micEnabledRef.current) {
      setMicEnabled(false); micEnabledRef.current = false
      setActiveBoth(false)
      void tauriInvoke('stt_stop')
    } else {
      setMicEnabled(true); micEnabledRef.current = true
      void tauriInvoke('stt_start')
    }
  }, [setActiveBoth])

  // Begin continuous listening on launch.
  useEffect(() => {
    if (micEnabledRef.current) void tauriInvoke('stt_start')
    return () => { void tauriInvoke('stt_stop') }
  }, [])

  // Picovoice "Jarvis" wake word (if configured) → enter a conversation too.
  useEffect(() => {
    let dispose: (() => void) | undefined
    tauriListen<void>('wake-word', () => { setActiveBoth(true); resetIdleTimer() }).then(fn => { dispose = fn })
    return () => dispose?.()
  }, [setActiveBoth, resetIdleTimer])

  // Eye tracker → move face eyeballs
  useEffect(() => {
    let dispose: (() => void) | undefined
    tauriListen<{ x: number | null; y: number | null }>('face-position', pos => {
      setEyePos(pos.x != null && pos.y != null ? { x: pos.x, y: pos.y } : null)
    }).then(fn => { dispose = fn })
    return () => dispose?.()
  }, [])

  // Speech-to-text events from the always-on macOS Speech sidecar
  useEffect(() => {
    const disposers: Array<() => void> = []

    tauriListen<string>('stt-partial', t => {
      const txt = (t || '').trim()
      if (busyRef.current) {
        // Barge-in: the user is speaking while Jarvis thinks/talks → stop and
        // listen. Ignore echo of Jarvis's own voice (no hardware AEC).
        const echo = isLikelyEcho(txt, spokenWords.current)
        if (shouldBargeIn(busyRef.current, txt) && !echo) {
          if (DIAG) console.warn('[barge-in] interrupting on:', JSON.stringify(txt))
          voiceOutput.cancel()
          chatSession.abort()
          setBusy(false); busyRef.current = false
          setActiveBoth(true); resetIdleTimer()
          setEmotion('listening')
          setInput(txt)
        } else if (DIAG && txt) {
          console.warn(`[barge-in] ignored (${echo ? 'echo' : 'short'}):`, JSON.stringify(txt))
        }
        return
      }
      if (activeRef.current) { setEmotion('listening'); setInput(txt) }
    }).then(d => disposers.push(d))

    tauriListen<string>('stt-final', raw => {
      const text = (raw || '').trim()
      if (!text) return
      if (DIAG) console.warn('[stt-final]', JSON.stringify(text), 'busy=', busyRef.current, 'active=', activeRef.current)
      if (activeRef.current) {
        void sendTextRef.current(text)
        return
      }
      // Idle: only act if the wake phrase is present.
      const m = text.match(WAKE_RE)
      if (!m) return
      setActiveBoth(true)
      resetIdleTimer()
      const rest = text.slice((m.index ?? 0) + m[0].length).trim()
      if (rest) void sendTextRef.current(rest)
      else { setEmotion('listening'); playChime() } // woke up, your turn
    }).then(d => disposers.push(d))

    tauriListen<{ state: string; detail: string }>('stt-status', s => {
      if (s.state === 'listening') setSttHint(null)
      if (s.state === 'error' || s.state === 'denied') {
        const d = s.detail || ''
        setSttHint(
          /dictation|siri/i.test(d)
            ? 'Enable Dictation in System Settings → Keyboard to use voice.'
            : d || 'Speech recognition is unavailable.',
        )
      }
    }).then(d => disposers.push(d))

    return () => disposers.forEach(d => d())
  }, [setActiveBoth, resetIdleTimer, voiceOutput, chatSession, playChime])

  // AgentConsole tool events → thinking emotion (but never interrupt speaking)
  useEffect(() => {
    return openAgentEvents(e => {
      if (e.type === 'tool_call')   setEmotion(prev => prev === 'speaking' ? prev : 'thinking')
      if (e.type === 'tool_result') setEmotion(prev => prev === 'thinking' ? 'idle' : prev)
    })
  }, [])

  const placeholder = !micEnabled
    ? 'Message Jarvis…'
    : active
      ? 'Listening…'
      : "Say “Hey Jarvis”…"

  return (
    <div className="callRoot">
      <div className="callMain">
        <div className="jf-panel">
          <JarvisFace emotion={emotion} eyePosition={eyePos} />
          <div className="jf-bottom-bar">
            <video ref={videoRef} autoPlay muted playsInline className="jf-cam-preview" />
            <input
              className="jf-text-input"
              type="text"
              placeholder={placeholder}
              value={input}
              disabled={busy}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void sendText(input) }}
            />
            <button
              type="button"
              className={`jf-mic ${!micEnabled ? 'off' : active ? 'active' : 'on'}`}
              onClick={toggleMic}
              title={!micEnabled ? 'Voice off — click to enable' : active ? 'In conversation' : "Listening for “Hey Jarvis” — click to mute"}
            >
              {micEnabled ? '🎤' : '🔇'}
            </button>
          </div>
          {sttHint && <div className="jf-stt-hint">{sttHint}</div>}
        </div>
      </div>
      <AgentConsole />
    </div>
  )
}
