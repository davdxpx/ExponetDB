import { describe, expect, it, vi } from 'vitest'
import {
  ENROLLMENT_KEY,
  forgetEnrollment,
  rememberEnrollment,
  rememberedEnrollment,
} from '../../src/features/enrollment/enrollment-storage.ts'
import { takeLinkToken } from '../../src/features/enrollment/link.ts'

const TOKEN = `exsu_${'A'.repeat(43)}`

describe('one-time link tokens', () => {
  it('removes the fragment from the address bar before the token is used', () => {
    const order: string[] = []
    const history = { replaceState: vi.fn(() => order.push('replace')) }
    const token = takeLinkToken('/setup', { pathname: '/setup', hash: `#token=${TOKEN}` }, history)
    order.push('use')
    expect(token).toBe(TOKEN)
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/setup')
    expect(order).toEqual(['replace', 'use'])
  })

  it('removes a fragment of the wrong kind too and yields nothing', () => {
    const history = { replaceState: vi.fn() }
    expect(
      takeLinkToken('/invite', { pathname: '/invite', hash: `#token=${TOKEN}` }, history),
    ).toBeUndefined()
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/invite')
  })

  it('leaves a page without fragment alone', () => {
    const history = { replaceState: vi.fn() }
    expect(takeLinkToken('/recover', { pathname: '/recover', hash: '' }, history)).toBeUndefined()
    expect(history.replaceState).not.toHaveBeenCalled()
  })
})

describe('enrollment progress in the tab', () => {
  const state = { kind: 'setup', email: 'owner@example.test', steps: { passkey: false } } as never

  it('keeps the progress, never the token, and forgets it', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    rememberEnrollment(storage, state)
    expect(store.get(ENROLLMENT_KEY)).not.toContain('exsu_')
    expect(rememberedEnrollment(storage)).toEqual(state)
    forgetEnrollment(storage)
    expect(rememberedEnrollment(storage)).toBeUndefined()
  })

  it('treats unusable storage and foreign values as nothing remembered', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
    }
    expect(() => rememberEnrollment(broken, state)).not.toThrow()
    expect(rememberedEnrollment(broken)).toBeUndefined()
    expect(() => forgetEnrollment(broken)).not.toThrow()
    const foreign = { getItem: () => '{"x":1}', setItem: () => {}, removeItem: () => {} }
    expect(rememberedEnrollment(foreign)).toBeUndefined()
  })
})
