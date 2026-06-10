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

  it('posts cleaned text; onStart fires on the speaking event, onEnd on success', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    const vo = createVoiceOutput()
    const onStart = vi.fn()
    const onEnd = vi.fn()
    vo.speak('<emotion value="happy"/> Hello!', onStart, onEnd)

    const [url, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/speak')
    expect(JSON.parse(opts.body as string).text).toBe('Hello!')

    // onStart waits for the server to report it's actually speaking.
    expect(onStart).not.toHaveBeenCalled()
    lastEventSource?.onmessage?.({ data: JSON.stringify({ type: 'state', state: 'speaking' }) })
    expect(onStart).toHaveBeenCalledOnce()

    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledOnce())
    expect(mockSpeechSynthesis.speak).not.toHaveBeenCalled()
  })

  it('falls back to speechSynthesis when the TTS server is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connection refused'))
    const vo = createVoiceOutput()
    vo.speak('Hello', () => {}, () => {})
    await vi.waitFor(() => expect(mockSpeechSynthesis.speak).toHaveBeenCalledOnce())
    const utt = mockSpeechSynthesis.speak.mock.calls[0][0]
    expect(utt.text).toBe('Hello')
  })

  it('skips empty text and calls onEnd immediately without any request', () => {
    const vo = createVoiceOutput()
    const onEnd = vi.fn()
    vo.speak('<emotion value="x"/>', () => {}, onEnd)
    expect(fetch).not.toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledOnce()
  })

  it('cancel posts /cancel and stops any system-voice fallback', () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }))
    const vo = createVoiceOutput()
    vo.cancel()
    const urls = vi.mocked(fetch).mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('/cancel'))).toBe(true)
    expect(mockSpeechSynthesis.cancel).toHaveBeenCalledOnce()
  })
})
