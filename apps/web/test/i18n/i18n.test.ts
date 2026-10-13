import { afterEach, describe, expect, it } from 'vitest'
import { ApiError } from '../../src/lib/api/errors.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { describeError, t, useCatalog } from '../../src/lib/i18n/i18n.ts'

afterEach(() => useCatalog(en))

describe('messages', () => {
  it('fills placeholders as text and keeps a missing one visible', () => {
    expect(t('error.rateLimited', { seconds: 7 })).toBe(
      'Too many attempts. Try again in 7 seconds.',
    )
    expect(t('error.withCode', { message: '<b>x</b>' })).toBe('<b>x</b> ({code})')
  })

  it('swaps the whole catalog', () => {
    useCatalog({ ...en, 'reauth.cancel': 'Abbrechen' })
    expect(t('reauth.cancel')).toBe('Abbrechen')
  })

  it('writes in sentence case without exclamation marks or "Submit"', () => {
    for (const [key, text] of Object.entries(en)) {
      expect(text, key).not.toMatch(/!|\bSubmit\b|\bOK\b/)
      expect(text.charAt(0), key).toBe(text.charAt(0).toUpperCase())
    }
  })
})

describe('error text', () => {
  it('shows the catalog message with its code', () => {
    expect(describeError(new ApiError('PLAN_STALE', 409, 'The plan is stale.'))).toBe(
      'The plan is stale. (PLAN_STALE)',
    )
  })

  it('uses fixed text for client failures and never exception text', () => {
    expect(describeError(new ApiError('NETWORK', 0, 'ECONNREFUSED 10.0.0.1'))).toBe(
      en['error.network'],
    )
    expect(describeError(new ApiError('REAUTH_CANCELED', 0, 'x'))).toBe(
      'Canceled. Nothing was changed.',
    )
    expect(describeError(new TypeError('Cannot read properties of undefined'))).toBe(
      en['error.unknown'],
    )
    expect(describeError('boom')).toBe(en['error.unknown'])
    const passkey = new Error('NotAllowedError: the operation timed out')
    passkey.name = 'PasskeyCanceled'
    expect(describeError(passkey)).toBe(en['passkey.canceled'])
  })

  it('names the retry time of a rate limit', () => {
    expect(describeError(new ApiError('RATE_LIMITED', 429, 'Too many.', 2.2))).toBe(
      'Too many attempts. Try again in 3 seconds.',
    )
    expect(describeError(new ApiError('RATE_LIMITED', 429, 'Too many.'))).toBe(
      'Too many. (RATE_LIMITED)',
    )
  })
})
