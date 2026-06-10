import { describe, it, expect } from 'vitest'
import { createSpeechChunker } from './speechChunker'

describe('createSpeechChunker', () => {
  it('emits sentences as terminators arrive across deltas', () => {
    const c = createSpeechChunker()
    expect(c.push('Hello the')).toEqual([])
    expect(c.push('re. How ')).toEqual(['Hello there.'])
    expect(c.push('are you?')).toEqual([])
    expect(c.flush()).toEqual(['How are you?'])
  })

  it('speaks an opening pacing line immediately, before the rest streams', () => {
    const c = createSpeechChunker()
    expect(c.push('On it, one sec. ')).toEqual(['On it, one sec.'])
    // …agent does tool work (no text)… then the answer arrives
    expect(c.push('The answer is four.\n')).toEqual(['The answer is four.'])
  })

  it('strips <emotion> tags from spoken sentences', () => {
    const c = createSpeechChunker()
    expect(c.push('<emotion value="happy"/> Sure thing! ')).toEqual(['Sure thing!'])
  })

  it('does not read fenced code aloud, emits a screen note instead', () => {
    const c = createSpeechChunker()
    const out = [
      ...c.push('Here is the config: ```json\n{"secret":1}\n``` '),
      ...c.push('All set.'),
      ...c.flush(),
    ]
    expect(out.join(' ')).not.toContain('secret')
    expect(out).toContain('Here is the config:')
    expect(out.some(s => /screen/i.test(s))).toBe(true)
    expect(out).toContain('All set.')
  })

  it('flush emits trailing text with no terminator', () => {
    const c = createSpeechChunker()
    expect(c.push('Just a tail with no period')).toEqual([])
    expect(c.flush()).toEqual(['Just a tail with no period'])
  })
})
