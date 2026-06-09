import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import './JarvisFace.css'

export type Emotion = 'idle' | 'speaking' | 'thinking' | 'happy' | 'surprised'

interface Props {
  emotion: Emotion
  eyePosition: { x: number; y: number } | null
}

const MAX_EYE_TRAVEL = 7 // px

export function JarvisFace({ emotion, eyePosition }: Props) {
  const pupilLRef = useRef<HTMLDivElement>(null)
  const pupilRRef = useRef<HTMLDivElement>(null)
  const [blinking, setBlinking] = useState(false)

  // Scheduled random blink
  useEffect(() => {
    let outer: ReturnType<typeof setTimeout>
    let inner: ReturnType<typeof setTimeout>
    function scheduleBlink() {
      outer = setTimeout(() => {
        setBlinking(true)
        inner = setTimeout(() => {
          setBlinking(false)
          scheduleBlink()
        }, 140)
      }, 2600 + Math.random() * 3400)
    }
    scheduleBlink()
    return () => { clearTimeout(outer); clearTimeout(inner) }
  }, [])

  // Eye position → pupil translation
  useLayoutEffect(() => {
    const x = eyePosition ? (eyePosition.x - 0.5) * 2 * MAX_EYE_TRAVEL : 0
    const y = eyePosition ? (eyePosition.y - 0.5) * 2 * MAX_EYE_TRAVEL : 0
    for (const ref of [pupilLRef, pupilRRef]) {
      if (ref.current) {
        ref.current.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
      }
    }
  }, [eyePosition])

  const eyeClass = `jf-eye-track${blinking ? ' blink' : ''}`

  return (
    <div className={`jf-shell ${emotion}`}>
      <div className="jf-ring-outer" />
      <div className="jf-ring-outer-2" />
      <div className="jf-face">
        <div className="jf-eyes">
          <div className={eyeClass}>
            <div className="jf-pupil" ref={pupilLRef} />
            <div className="jf-eyelid" />
          </div>
          <div className={eyeClass}>
            <div className="jf-pupil" ref={pupilRRef} />
            <div className="jf-eyelid" />
          </div>
        </div>

        <div className="jf-mouth">
          <div className="jf-mouth-line" />
          <div className="jf-wave-bars">
            {[0, 1, 2, 3, 4, 5, 6].map(i => <div key={i} className="jf-wave-bar" />)}
          </div>
          <div className="jf-mouth-smile" />
          <div className="jf-mouth-dots">
            <div className="jf-tdot" /><div className="jf-tdot" /><div className="jf-tdot" />
          </div>
          <div className="jf-mouth-o" />
        </div>

        <div className="jf-status">{emotion.toUpperCase()}</div>
      </div>
    </div>
  )
}
