import { useState } from 'react'
import { JarvisFace, type Emotion } from './components/JarvisFace'
import './App.css'

const EMOTIONS: Emotion[] = ['idle', 'speaking', 'thinking', 'happy', 'surprised']

function App() {
  const [emotion, setEmotion] = useState<Emotion>('idle')
  return (
    <div style={{ background: '#080808', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
      <JarvisFace emotion={emotion} eyePosition={{ x: 0.5, y: 0.5 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        {EMOTIONS.map(e => (
          <button key={e} onClick={() => setEmotion(e)}
            style={{ padding: '6px 14px', borderRadius: 999, border: '1px solid #333', background: emotion === e ? '#222' : '#111', color: '#ccc', cursor: 'pointer' }}>
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}

export default App
