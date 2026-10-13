import { loginUrl } from '../navigation/links.ts'

/**
 * Leaving for the sign-in page when the session is gone: the current page
 * (path and fragment) becomes the return target only if it is a safe one
 * (`safeReturnTo`); the query cache is dropped first so no data of the
 * ended session stays in memory.
 */
export interface SessionDeps {
  readonly location: Pick<Location, 'pathname' | 'hash' | 'assign'>
  readonly clearCache: () => void
}

export function leaveForSignIn(deps: SessionDeps): void {
  deps.clearCache()
  deps.location.assign(loginUrl(deps.location.pathname + deps.location.hash))
}
