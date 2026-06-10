import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createVoiceOutput, stripEmotionTags, toSpokenText } from './voiceOutput'

describe('stripEmotionTags', () => {
  it('removes <emotion value="x"/> tags', () => {
    expect(stripEmotionTags('<emotion value="happy"/> Hello there.')).toBe('Hello there.')
  })
  it('removes inline emotion tags mid-sentence', () => {
    expect(stripEmotionTags('Sure!<emotion value="excited"/> Let me check.')).toBe('Sure! Let me check.')
  })
  it('passes plain text unchanged', () => {
    expect(stripEmotionTags('Hello world')).toBe('Hello world')
  })
})

describe('toSpokenText', () => {
  it('leaves a short reply unchanged (minus emotion tags)', () => {
    expect(toSpokenText('<emotion value="x"/> Two plus two is four.')).toBe('Two plus two is four.')
  })
  it('does not read fenced code blocks aloud', () => {
    const out = toSpokenText('Here is the config:\n```json\n{"secret":"value","a":1}\n```')
    expect(out).not.toContain('secret')
    expect(out.toLowerCase()).toContain('screen')
  })
  it('summarizes a very long reply to a lead-in plus a screen note', () => {
    const long = 'Here is what I found. ' + 'data '.repeat(300)
    const out = toSpokenText(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out.toLowerCase()).toContain('screen')
    expect(out).toContain('Here is what I found.')
  })
})

describe('createVoiceOutput', () => {
  let mockSpeechSynthesis: {
    cancel: ReturnType<typeof vi.fn>
    speak: ReturnType<typeof vi.fn>
    getVoices: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    mockSpeechSynthesis = {
      cancel: vi.fn(),
      speak: vi.fn(),
      getVoices: vi.fn().mockReturnValue([]),
    }
    vi.stubGlobal('speechSynthesis', mockSpeechSynthesis)
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      voice: unknown = null
      onstart: (() => void) | null = null
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      text: string
      constructor(text: string) { this.text = text }
    })
  })

  it('calls speechSynthesis.speak with cleaned text', () => {
    const vo = createVoiceOutput()
    vo.speak('<emotion value="happy"/> Hello!', () => {}, () => {})
    expect(mockSpeechSynthesis.speak).toHaveBeenCalledOnce()
    const utt = mockSpeechSynthesis.speak.mock.calls[0][0]
    expect(utt.text).toBe('Hello!')
  })

  it('calls onEnd when utterance ends', () => {
    const vo = createVoiceOutput()
    const onEnd = vi.fn()
    vo.speak('Hello', () => {}, onEnd)
    const utt = mockSpeechSynthesis.speak.mock.calls[0][0]
    utt.onend()
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('skips speaking empty text and calls onEnd immediately', () => {
    const vo = createVoiceOutput()
    const onEnd = vi.fn()
    vo.speak('<emotion value="x"/>', () => {}, onEnd)
    expect(mockSpeechSynthesis.speak).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('cancel calls speechSynthesis.cancel', () => {
    const vo = createVoiceOutput()
    vo.cancel()
    expect(mockSpeechSynthesis.cancel).toHaveBeenCalledOnce()
  })
})
