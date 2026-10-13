import { describe, expect, it, vi } from 'vitest'
import { leaveForSignIn } from '../../src/lib/session/session.ts'

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
})
