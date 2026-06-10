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
  let lastEventSource: { onmessage: ((e: { data: string }) => void) | null } | null

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
    lastEventSource = null
    vi.stubGlobal('EventSource', class {
      onmessage: ((e: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      url: string
      constructor(url: string) { this.url = url; lastEventSource = this }
      close() {}
    })
    vi.stubGlobal('fetch', vi.fn())
  })

  function emit(state: string) {
    lastEventSource?.onmessage?.({ data: JSON.stringify({ type: 'state', state }) })
  }

  it('enqueues cleaned text to /speak; onStart on speaking, onEnd on idle', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const vo = createVoiceOutput()
    const onStart = vi.fn()
    const onEnd = vi.fn()
    vo.speak('<emotion value="happy"/> Hello!', onStart, onEnd)

    await vi.waitFor(() => {
      const speak = vi.mocked(fetch).mock.calls.find(c => String(c[0]).includes('/speak'))
      expect(speak).toBeTruthy()
      expect(JSON.parse((speak![1] as RequestInit).body as string).text).toBe('Hello!')
    })

    expect(onStart).not.toHaveBeenCalled()
    emit('speaking')
    expect(onStart).toHaveBeenCalledOnce()

    expect(onEnd).not.toHaveBeenCalled()
    emit('idle')
    expect(onEnd).toHaveBeenCalledOnce()
    expect(mockSpeechSynthesis.speak).not.toHaveBeenCalled()
  })

  it('falls back to the system voice when the server is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connection refused'))
    const vo = createVoiceOutput()
    vo.speak('Hello there', () => {}, () => {})
    await vi.waitFor(() => expect(mockSpeechSynthesis.speak).toHaveBeenCalledOnce())
    expect(mockSpeechSynthesis.speak.mock.calls[0][0].text).toBe('Hello there')
  })

  it('skips empty text: no /speak request, ends on idle', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const vo = createVoiceOutput()
    const onEnd = vi.fn()
    vo.speak('<emotion value="x"/>', () => {}, onEnd)
    await vi.waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
      expect(urls.some(u => u.includes('/done'))).toBe(true)
    })
    expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).includes('/speak'))).toBe(false)
    emit('idle')
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('cancel posts /cancel and stops the system voice', () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const vo = createVoiceOutput()
    vo.cancel()
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/cancel'))).toBe(true)
    expect(mockSpeechSynthesis.cancel).toHaveBeenCalledOnce()
  })
})
