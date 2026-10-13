import { describe, expect, it } from 'vitest'
import { codeLetters, formatUserCode, isCompleteCode } from '../../src/features/device/user-code.ts'

describe('the user code of a device sign-in', () => {
  it('keeps the letters only, in upper case, at most eight', () => {
    expect(codeLetters('bcdf-ghjk')).toBe('BCDFGHJK')
    expect(codeLetters(' BCDF GHJK ')).toBe('BCDFGHJK')
    expect(codeLetters('bcdf-ghjk-lmnp')).toBe('BCDFGHJK')
    expect(codeLetters('12<script>')).toBe('SCRIPT')
    // A letter that changes length in upper case is no code letter.
    expect(codeLetters('ßbc')).toBe('BC')
    expect(codeLetters('ＢＣＤＦ')).toBe('')
  })

  it('is complete with exactly eight letters', () => {
    expect(isCompleteCode('BCDFGHJK')).toBe(true)
    expect(isCompleteCode('BCDFGHJ')).toBe(false)
    expect(isCompleteCode('BCDFGHJK1')).toBe(false)
    expect(isCompleteCode('bcdfghjk')).toBe(false)
  })

  it('is sent in the shape the device shows', () => {
    expect(formatUserCode('BCDFGHJK')).toBe('BCDF-GHJK')
    expect(formatUserCode('BCD')).toBe('BCD')
  })
})
