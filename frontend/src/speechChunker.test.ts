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

  it('strips markdown so it is not read aloud as symbols', () => {
    const c = createSpeechChunker()
    expect(c.push('Here is **really** important stuff. ')).toEqual(['Here is really important stuff.'])
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

  it('splits a pacing line from the next block when the model drops the space', () => {
    // Real case: the agent ends the pacing block and starts the next with no
    // space across the tool boundary ("right now!Got the results!").
    const c = createSpeechChunker()
    const out = [...c.push('Let me look that up right now!Got the results! '), ...c.flush()]
    expect(out[0]).toBe('Let me look that up right now!')
    expect(out).toContain('Got the results!')
  })

  it('flush emits trailing text with no terminator', () => {
    const c = createSpeechChunker()
    expect(c.push('Just a tail with no period')).toEqual([])
    expect(c.flush()).toEqual(['Just a tail with no period'])
  })
})
