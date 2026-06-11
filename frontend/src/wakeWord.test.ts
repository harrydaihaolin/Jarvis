import { describe, expect, it } from 'vitest'
import { matchWake } from './wakeWord'

describe('matchWake', () => {
  it('matches "Hey Jarvis" with a trailing command', () => {
    expect(matchWake("Hey Jarvis, what's the weather")).toBe("what's the weather")
  })

  it('matches a bare "Jarvis" with no command', () => {
    expect(matchWake('Jarvis')).toBe('')
    expect(matchWake('Jarvis.')).toBe('')
  })

  it('is case-insensitive and accepts hi/ok/okay prefixes', () => {
    expect(matchWake('OK JARVIS turn it up')).toBe('turn it up')
    expect(matchWake('okay jarvis')).toBe('')
    expect(matchWake('hi jarvis open the console')).toBe('open the console')
  })

  it('tolerates a comma between prefix and name', () => {
    expect(matchWake('Hey, Jarvis, lights on')).toBe('lights on')
  })

  it('matches mid-utterance', () => {
    expect(matchWake('um hey jarvis what time is it')).toBe('what time is it')
  })

  it('matches close mishears bare', () => {
    for (const v of ['jarvus', 'jervis', 'javis', 'jarvas', 'garvis', 'harvis', 'darvis', 'charvis']) {
      expect(matchWake(`${v} hello`), v).toBe('hello')
    }
  })

  it('matches name-collision mishears only with a wake prefix', () => {
    expect(matchWake('hey travis what time is it')).toBe('what time is it')
    expect(matchWake('ok davis')).toBe('')
    expect(matchWake('hey harvest lights on')).toBe('lights on')
  })

  it('does NOT wake on name-collision mishears without a prefix', () => {
    expect(matchWake('I told Travis about it')).toBeNull()
    expect(matchWake('Davis is coming over')).toBeNull()
    expect(matchWake('the harvest was good this year')).toBeNull()
  })

  it('returns null for unrelated speech', () => {
    expect(matchWake('what a nice day')).toBeNull()
    expect(matchWake('')).toBeNull()
  })

  it('does not match inside larger words', () => {
    expect(matchWake('jarvisson said hello')).toBeNull()
  })
})
