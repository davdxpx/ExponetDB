import { describe, expect, it, vi } from 'vitest'
import {
  isSessionlessPath,
  leaveForSignIn,
  SESSIONLESS_PATHS,
} from '../../src/lib/session/session.ts'

describe('leaving for the sign-in page', () => {
  it('drops the cache and returns to a safe page only', () => {
    const assign = vi.fn()
    const clearCache = vi.fn()
    leaveForSignIn({
      location: { pathname: '/changes/plans/pln_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', hash: '', assign },
      clearCache,
    })
    expect(clearCache).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith(
      `/login?returnTo=${encodeURIComponent('/changes/plans/pln_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z')}`,
    )
    leaveForSignIn({
      location: { pathname: '/t/a/b/c/schema/tables/x.y', hash: '#z', assign },
      clearCache,
    })
    expect(assign).toHaveBeenLastCalledWith('/login')
  })

  it('on a page without a session only drops the cache: it never loads the sign-in page again', () => {
    for (const pathname of [...SESSIONLESS_PATHS, '/login/', '/setup/']) {
      const assign = vi.fn()
      const clearCache = vi.fn()
      leaveForSignIn({ location: { pathname, hash: '#token=gone', assign }, clearCache })
      expect(clearCache, pathname).toHaveBeenCalledTimes(1)
      expect(assign, pathname).not.toHaveBeenCalled()
    }
  })

  it('treats only the exact pages without a session as such', () => {
    expect(SESSIONLESS_PATHS).toEqual(['/login', '/setup', '/invite', '/recover', '/oauth/error'])
    for (const pathname of [
      '/account',
      '/oauth/consent',
      '/oauth/device',
      '/step-up',
      '/credentials',
      '/approvals',
      '/loginx',
      '/login/x',
      '/LOGIN',
      '/oauth/error/x',
      '/',
    ]) {
      expect(isSessionlessPath(pathname), pathname).toBe(false)
    }
  })
})
