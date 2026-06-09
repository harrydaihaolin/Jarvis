import { useCallback, useState } from 'react'
import { Conversation } from './components/cvi/components/conversation'
import { AgentConsole } from './AgentConsole'
import { createConversation, endConversation, type ConversationInfo } from './api'
import './App.css'

type Phase = 'idle' | 'starting' | 'in-call' | 'error'

function App() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [convo, setConvo] = useState<ConversationInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = useCallback(async () => {
    setPhase('starting')
    setError(null)
    try {
      const data = await createConversation()
      setConvo(data)
      setPhase('in-call')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [])

  const leave = useCallback(async () => {
    const id = convo?.conversation_id
    setPhase('idle')
    setConvo(null)
    // Best-effort: end the conversation to stop billing.
    if (id) {
      try {
        await endConversation(id)
      } catch {
        /* ignore */
      }
    }
  }, [convo])

  if (phase === 'in-call' && convo) {
    return (
      <div className="callRoot">
        <div className="callMain">
          {convo.test_mode && (
            <div
              className="testBadge"
              title="test_mode is on — no Tavus minutes are billed, replica may be limited"
            >
              test mode
            </div>
          )}
          <Conversation conversationUrl={convo.conversation_url} onLeave={leave} />
        </div>
        <AgentConsole />
      </div>
    )
  }

  return (
    <div className="landing">
      <div className="card">
        <h1>Claude Video Agent</h1>
        <p className="subtitle">
          A face-to-face video agent: a Tavus replica that sees, hears, and speaks, with{' '}
          <strong>Claude</strong> as the brain.
        </p>

        <button className="startButton" onClick={start} disabled={phase === 'starting'}>
          {phase === 'starting' ? 'Connecting…' : 'Start conversation'}
        </button>

        {phase === 'error' && (
          <div className="error">
            <strong>Couldn’t start.</strong> {error}
            <div className="hint">
              Check that the dev backend is running and your <code>.env</code> has a valid{' '}
              <code>TAVUS_API_KEY</code>. If using the custom proxy, ngrok must be up.
            </div>
          </div>
        )}

        <p className="footnote">Camera and microphone access is required.</p>
      </div>
    </div>
  )
}

export default App
