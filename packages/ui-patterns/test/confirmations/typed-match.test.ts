import { describe, expect, it } from 'vitest'

import {
  confirmationMismatch,
  confirmationMismatchMessage,
  matchesExpectedText,
  normalizeConfirmationText,
} from '../../src/confirmations/typed-match.ts'

const PATH = 'shop/platform/production'

describe('matchesExpectedText', () => {
  it('matches the exact text only', () => {
    expect(matchesExpectedText(PATH, PATH)).toBe(true)
    expect(matchesExpectedText('shop/platform/staging', PATH)).toBe(false)
    expect(matchesExpectedText('shop/platform/productio', PATH)).toBe(false)
    expect(matchesExpectedText(`${PATH}x`, PATH)).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(matchesExpectedText('Shop/platform/production', PATH)).toBe(false)
    expect(matchesExpectedText(PATH.toUpperCase(), PATH)).toBe(false)
    expect(matchesExpectedText('Users', 'users')).toBe(false)
  })

  it('normalizes both sides to NFC', () => {
    const composed = 'caf\u00e9'
    const decomposed = 'cafe\u0301'
    expect(normalizeConfirmationText(decomposed)).toBe(composed)
    expect(matchesExpectedText(decomposed, composed)).toBe(true)
    expect(matchesExpectedText(composed, decomposed)).toBe(true)
  })

  it('folds nothing beyond NFC: compatibility look-alikes stay different', () => {
    // NFKC would turn these into the ASCII text; NFC keeps them apart.
    expect(matchesExpectedText('\uff53hop/platform/production', PATH)).toBe(false) // fullwidth s
    expect(matchesExpectedText('\ufb01les', 'files')).toBe(false) // fi ligature
    // A Cyrillic a is not a Latin a.
    expect(matchesExpectedText('p\u0430yments', 'payments')).toBe(false)
  })

  it('trims nothing: whitespace before, after or inside is a mismatch', () => {
    expect(matchesExpectedText(` ${PATH}`, PATH)).toBe(false)
    expect(matchesExpectedText(`${PATH} `, PATH)).toBe(false)
    expect(matchesExpectedText(`${PATH}\t`, PATH)).toBe(false)
    expect(matchesExpectedText('shop/platform /production', PATH)).toBe(false)
    expect(matchesExpectedText('order items', 'order  items')).toBe(false)
    // An expected text with a space at its end needs that space.
    expect(matchesExpectedText('users ', 'users ')).toBe(true)
    expect(matchesExpectedText('users', 'users ')).toBe(false)
  })

  it('counts invisible and direction characters like any other character', () => {
    expect(matchesExpectedText('users', 'users\u200b')).toBe(false)
    expect(matchesExpectedText('users\u200b', 'users')).toBe(false)
    expect(matchesExpectedText('users\u200b', 'users\u200b')).toBe(true)
    expect(matchesExpectedText('\u202eusers', 'users')).toBe(false)
  })

  it('never matches an empty expected text', () => {
    expect(matchesExpectedText('', '')).toBe(false)
    expect(matchesExpectedText('anything', '')).toBe(false)
  })
})

describe('confirmationMismatch', () => {
  it('is null for a match', () => {
    expect(confirmationMismatch(PATH, PATH)).toBeNull()
  })

  it('names an empty field, a surrounding space, a case difference and anything else', () => {
    expect(confirmationMismatch('', PATH)).toBe('empty')
    expect(confirmationMismatch(` ${PATH} `, PATH)).toBe('surrounding-space')
    expect(confirmationMismatch('SHOP/platform/production', PATH)).toBe('case')
    expect(confirmationMismatch('shop/platform/staging', PATH)).toBe('different')
    expect(confirmationMismatch('users', 'users\u200b')).toBe('different')
  })

  it('has a message for each kind', () => {
    expect(confirmationMismatchMessage('empty')).toBe('Type the text shown above to continue.')
    expect(confirmationMismatchMessage('surrounding-space')).toBe(
      'Remove the space before or after the text.',
    )
    expect(confirmationMismatchMessage('case')).toBe(
      'The text must match exactly, including upper and lower case.',
    )
    expect(confirmationMismatchMessage('different')).toBe(
      'The text does not match. Type it exactly as shown.',
    )
  })
})
