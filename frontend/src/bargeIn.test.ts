import { describe, it, expect } from 'vitest'
import { shouldBargeIn, isLikelyEcho, wordsOf } from './bargeIn'

describe('isLikelyEcho', () => {
  const spoken = new Set(wordsOf('The capital of France is Paris and it is lovely'))

  it('treats a transcript of Jarvis’s own words as echo', () => {
    expect(isLikelyEcho('the capital of France is Paris', spoken)).toBe(true)
  })

  it('does not treat the user’s different words as echo', () => {
    expect(isLikelyEcho('stop wait hold on', spoken)).toBe(false)
  })

  it('treats empty as echo (nothing to interrupt with)', () => {
    expect(isLikelyEcho('', spoken)).toBe(true)
  })
})

describe('shouldBargeIn', () => {
  it('interrupts on a substantial partial while Jarvis is busy', () => {
    expect(shouldBargeIn(true, 'stop, wait')).toBe(true)
    expect(shouldBargeIn(true, 'actually')).toBe(true)
  })

  it('ignores tiny/blank partials (echo residue) while busy', () => {
    expect(shouldBargeIn(true, 'um')).toBe(false) // < 3 chars
    expect(shouldBargeIn(true, '   ')).toBe(false)
    expect(shouldBargeIn(true, '')).toBe(false)
  })

  it('never interrupts when not in a turn', () => {
    expect(shouldBargeIn(false, 'hey jarvis what is the time')).toBe(false)
  })
})
