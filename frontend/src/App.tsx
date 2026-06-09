import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JarvisFace, type Emotion } from './components/JarvisFace'
import { AgentConsole } from './AgentConsole'
import { createVoiceOutput } from './voiceOutput'
import { createChatSession } from './chatSession'
import { openAgentEvents } from './agentEvents'
import './App.css'

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function tauriListen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, e => cb(e.payload))
}

export default function App() {
  const [emotion, setEmotion] = useState<Emotion>('idle')
  const [eyePos, setEyePos] = useState<{ x: number; y: number } | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const voiceOutput = useMemo(() => createVoiceOutput(), [])
  const chatSession = useMemo(() => createChatSession(), [])

  // Camera preview (display only — eye tracker opens its own AVCapture session)
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then(stream => { if (videoRef.current) videoRef.current.srcObject = stream })
      .catch(() => { /* permission denied — hide silently */ })
  }, [])

  // Wake word → focus input
  useEffect(() => {
    let dispose: (() => void) | undefined
    tauriListen<void>('wake-word', () => inputRef.current?.focus()).then(fn => { dispose = fn })
    return () => dispose?.()
  }, [])

  // Eye tracker → move face eyeballs
  useEffect(() => {
    let dispose: (() => void) | undefined
    tauriListen<{ x: number | null; y: number | null }>('face-position', pos => {
      setEyePos(pos.x != null && pos.y != null ? { x: pos.x, y: pos.y } : null)
    }).then(fn => { dispose = fn })
    return () => dispose?.()
  }, [])

  // AgentConsole tool events → thinking emotion
  useEffect(() => {
    return openAgentEvents(e => {
      if (e.type === 'tool_call')   setEmotion('thinking')
      if (e.type === 'tool_result') setEmotion(prev => prev === 'thinking' ? 'idle' : prev)
    })
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    setEmotion('thinking')
    voiceOutput.cancel()
    try {
      const reply = await chatSession.send(text)
      setEmotion('speaking')
      voiceOutput.speak(
        reply,
        () => setEmotion('speaking'),
        () => { setEmotion('idle'); setBusy(false) },
      )
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setEmotion('idle')
        setBusy(false)
      }
    }
  }, [input, busy, chatSession, voiceOutput])

  return (
    <div className="callRoot">
      <div className="callMain">
        <div className="jf-panel">
          <JarvisFace emotion={emotion} eyePosition={eyePos} />
          <div className="jf-bottom-bar">
            <video ref={videoRef} autoPlay muted playsInline className="jf-cam-preview" />
            <input
              ref={inputRef}
              className="jf-text-input"
              type="text"
              placeholder="Message Jarvis…"
              value={input}
              disabled={busy}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void send() }}
            />
          </div>
        </div>
      </div>
      <AgentConsole />
    </div>
  )
}
