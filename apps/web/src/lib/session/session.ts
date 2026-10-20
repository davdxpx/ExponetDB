import { forgetRecentTargets } from '../../features/target/recent.ts'
import { loginUrl } from '../navigation/links.ts'
import { forgetSqlTabs } from '../storage/sql-tabs.ts'

/**
 * Leaving for the sign-in page when the session is gone: the query cache is
 * dropped first so no data of the ended session stays in memory, then the
 * browser loads the sign-in page with the current page (path and fragment)
 * as the return target only if it is a safe one (`safeReturnTo`).
 *
 * On the pages that work without a session (sign-in, the one-time links,
 * the authorization error page) the cache is dropped and the page stays:
 * the sign-in page asks whether a session exists through the same client,
 * and an answer of "no session" there must never load the sign-in page
 * again (no loop), nor interrupt an enrollment in progress.
 *
 * Either way the SQL tabs this browser kept (`SQL_TABS_PREFIX`) are removed:
 * the unsent text of an ended session never waits for the next person.
 */
export interface SessionDeps {
  readonly location: Pick<Location, 'pathname' | 'hash' | 'assign'>
  readonly clearCache: () => void
}

/** The pages that need no session (their routes sit outside the session guard). */
export const SESSIONLESS_PATHS: readonly string[] = [
  '/login',
  '/setup',
  '/invite',
  '/recover',
  '/oauth/error',
]

export function isSessionlessPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  return SESSIONLESS_PATHS.includes(path)
}

export function leaveForSignIn(deps: SessionDeps): void {
  deps.clearCache()
  forgetSqlTabs()
  forgetRecentTargets()
  if (isSessionlessPath(deps.location.pathname)) return
  deps.location.assign(loginUrl(deps.location.pathname + deps.location.hash))
}
