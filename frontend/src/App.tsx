import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { JarvisFace, type Emotion } from './components/JarvisFace'
import { AgentConsole } from './AgentConsole'
import { createVoiceOutput } from './voiceOutput'
import { createChatSession } from './chatSession'
import { createSpeechChunker } from './speechChunker'
import { shouldBargeIn, isLikelyEcho, wordsOf } from './bargeIn'
import { matchWake } from './wakeWord'

// Diagnosis mode: log the voice pipeline (barge-in, finals) to the dev console.
// On by default; set VITE_DIAGNOSTICS=0 to silence.
const DIAG = (import.meta.env.VITE_DIAGNOSTICS ?? '1') !== '0'
import { openAgentEvents } from './agentEvents'
import './App.css'

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Subscribe to a Tauri event; returns a synchronous disposer that is safe to
// call before the underlying async `listen()` resolves. Without this, React
// StrictMode's mount→cleanup→mount cycle leaks the first listener (cleanup
// runs before the promise resolves) and every event fires twice.
function tauriListen<T>(event: string, cb: (payload: T) => void): () => void {
  if (!isTauri()) return () => {}
  let disposed = false
  let unlisten: (() => void) | undefined
  void listen<T>(event, e => cb(e.payload)).then(fn => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => { disposed = true; unlisten?.() }
}

async function tauriInvoke(cmd: string): Promise<void> {
  if (!isTauri()) return
  try { await invoke(cmd) } catch { /* ignore */ }
}

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
  // Words Jarvis is currently speaking — used to reject mic echo that the
  // hardware echo cancellation didn't fully remove.
  const spokenWords = useRef<Set<string>>(new Set())
  // STT finals lag behind the audio (~1-2s silence detection), so echo of
  // Jarvis's last words can arrive after the turn ends. Until this deadline,
  // finals matching what Jarvis just said are dropped instead of re-entering
  // the conversation (the "Jarvis replies to himself" loop).
  const echoGuardUntil = useRef(0)

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

  // Stop Jarvis mid-turn and hand the floor back to the user. Used by the Esc
  // key, clicking Jarvis, and (when audio is clean) a voice barge-in.
  const interrupt = useCallback(() => {
    if (!busyRef.current) return
    if (DIAG) console.warn('[interrupt]')
    echoGuardUntil.current = Date.now() + 2500
    voiceOutput.cancel()
    chatSession.abort()
    setBusy(false); busyRef.current = false
    setActiveBoth(true); resetIdleTimer()
    setEmotion('listening')
    if (micEnabledRef.current) void tauriInvoke('stt_resume') // mic was paused while speaking
  }, [voiceOutput, chatSession, setActiveBoth, resetIdleTimer])

  // Esc key interrupts (reliable on speakers, no echo issues).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') interrupt() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [interrupt])

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
      echoGuardUntil.current = Date.now() + 2500
      setBusy(false); busyRef.current = false
      // Reopen the mic now that Jarvis has finished talking.
      if (micEnabledRef.current) void tauriInvoke('stt_resume')
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
    // Close the mic the moment audio starts: the built-in mic + speakers can't
    // run Apple's hardware echo cancellation (the spatial-audio output is
    // multichannel, which VPIO refuses), so if we keep listening we transcribe
    // Jarvis's own voice and he replies to himself. The mic stays live during
    // the thinking phase, and reopens in turnDone()/interrupt().
    const stream = voiceOutput.speakStream(
      () => { void tauriInvoke('stt_pause'); setEmotion('speaking') },
      () => finish(),
    )
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
    return tauriListen<void>('wake-word', () => { setActiveBoth(true); resetIdleTimer() })
  }, [setActiveBoth, resetIdleTimer])

  // Eye tracker → move face eyeballs
  useEffect(() => {
    return tauriListen<{ x: number | null; y: number | null }>('face-position', pos => {
      setEyePos(pos.x != null && pos.y != null ? { x: pos.x, y: pos.y } : null)
    })
  }, [])

  // Speech-to-text events from the always-on macOS Speech sidecar
  useEffect(() => {
    const disposers: Array<() => void> = []

    disposers.push(tauriListen<string>('stt-partial', t => {
      const txt = (t || '').trim()
      if (busyRef.current) {
        // Barge-in: the user is speaking while Jarvis thinks/talks → stop and
        // listen. Ignore echo of Jarvis's own voice (no hardware AEC).
        const echo = isLikelyEcho(txt, spokenWords.current)
        if (shouldBargeIn(busyRef.current, txt) && !echo) {
          if (DIAG) console.warn('[barge-in] interrupting on:', JSON.stringify(txt))
          interrupt()
          setInput(txt)
        } else if (DIAG && txt) {
          console.warn(`[barge-in] ignored (${echo ? 'echo' : 'short'}):`, JSON.stringify(txt))
        }
        return
      }
      if (activeRef.current) { setEmotion('listening'); setInput(txt) }
    }))

    disposers.push(tauriListen<string>('stt-final', raw => {
      const text = (raw || '').trim()
      if (!text) return
      if (DIAG) console.warn('[stt-final]', JSON.stringify(text), 'busy=', busyRef.current, 'active=', activeRef.current)
      // Echo rejection: while Jarvis speaks (and shortly after — finals lag the
      // audio), drop transcripts that are mostly his own words.
      if ((busyRef.current || Date.now() < echoGuardUntil.current) && isLikelyEcho(text, spokenWords.current)) {
        if (DIAG) console.warn('[stt-final] dropped as echo:', JSON.stringify(text))
        return
      }
      if (activeRef.current) {
        void sendTextRef.current(text)
        return
      }
      // Idle: only act if the wake phrase is present.
      const rest = matchWake(text)
      if (rest === null) return
      setActiveBoth(true)
      resetIdleTimer()
      if (rest) void sendTextRef.current(rest)
      else { setEmotion('listening'); playChime() } // woke up, your turn
    }))

    disposers.push(tauriListen<{ state: string; detail: string }>('stt-status', s => {
      // A fresh sidecar (initial spawn or respawn after a crash) comes up idle;
      // re-arm it so "Hey Jarvis" keeps working without an app restart.
      if (s.state === 'ready' && micEnabledRef.current) void tauriInvoke('stt_start')
      if (s.state === 'listening') setSttHint(null)
      if (s.state === 'error' || s.state === 'denied') {
        const d = s.detail || ''
        setSttHint(
          /dictation|siri/i.test(d)
            ? 'Enable Dictation in System Settings → Keyboard to use voice.'
            : d || 'Speech recognition is unavailable.',
        )
      }
    }))

    return () => disposers.forEach(d => d())
  }, [setActiveBoth, resetIdleTimer, voiceOutput, chatSession, playChime, interrupt])

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
          <div
            className="jf-face-click"
            style={{ cursor: busy ? 'pointer' : 'default' }}
            onClick={interrupt}
            title={busy ? 'Click (or press Esc) to interrupt' : undefined}
          >
            <JarvisFace emotion={emotion} eyePosition={eyePos} />
          </div>
          {busy && <div className="jf-interrupt-hint">click or press Esc to interrupt</div>}
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
