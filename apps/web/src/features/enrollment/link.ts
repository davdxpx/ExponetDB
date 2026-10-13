import type { EnrollmentState } from '@exponetdb/contracts'
import { type LinkPage, linkToken } from '../../lib/navigation/links.ts'

/**
 * Takes the one-time token of a setup, invitation or recovery link from the
 * fragment and removes the fragment from the address bar and the history
 * entry **before** anything else runs (the token is never redeemed while it
 * is still visible, logged or stored). A fragment of the wrong kind is
 * removed as well and yields nothing.
 */
export interface LinkLocation {
  readonly pathname: string
  readonly hash: string
}

export interface LinkHistory {
  replaceState(data: unknown, unused: string, url: string): void
}

export function takeLinkToken(
  page: LinkPage,
  location: LinkLocation,
  history: LinkHistory,
): string | undefined {
  const token = linkToken(page, location.hash)
  if (location.hash !== '') {
    history.replaceState(null, '', location.pathname)
  }
  return token
}

const LINK_PAGES: readonly LinkPage[] = ['/setup', '/invite', '/recover']

/**
 * The link page a path names, as the router matches it (letter case and a
 * trailing slash do not matter), or undefined for any other page.
 */
export function linkPageOf(pathname: string): LinkPage | undefined {
  const normalized = pathname.toLowerCase().replace(/\/+$/, '')
  return LINK_PAGES.find((page) => page === normalized)
}

/**
 * The token taken at start-up, held in this module's memory only (never in
 * the query cache, storage or the router's state) until its page redeems it.
 */
let held: { readonly page: LinkPage; readonly token: string } | undefined
let redemption: { readonly page: LinkPage; readonly result: Promise<EnrollmentState> } | undefined

/**
 * Called by `main.tsx` before the router, the API client or anything else
 * that could send a request or read the address: on a link page, the
 * fragment leaves the address bar and the history entry at once and a token
 * of the page's kind is held for the page. Any other page is left alone.
 * Also called on `hashchange` by a link page (a second link opened in the
 * same tab). Returns whether a token is now held.
 */
export function holdOneTimeLink(location: LinkLocation, history: LinkHistory): boolean {
  const page = linkPageOf(location.pathname)
  if (page === undefined) return false
  const token = takeLinkToken(page, location, history)
  if (token === undefined) return false
  held = { page, token }
  return true
}

/**
 * Redeems the token held for `page` once: the token leaves this module's
 * memory as the request starts, and a second call while that request runs
 * (a component mounted twice) gets the same answer instead of a second
 * redemption. Returns undefined when no token is held for the page.
 */
export function redeemHeldLink(
  page: LinkPage,
  redeem: (token: string) => Promise<EnrollmentState>,
): Promise<EnrollmentState> | undefined {
  if (held?.page === page) {
    const { token } = held
    held = undefined
    const result = redeem(token)
    const current = { page, result }
    redemption = current
    const settle = (): void => {
      if (redemption === current) redemption = undefined
    }
    result.then(settle, settle)
    return result
  }
  if (redemption?.page === page) {
    return redemption.result
  }
  return undefined
}

/** Drops a held token and a running redemption (tests; a page that leaves). */
export function forgetHeldLink(): void {
  held = undefined
  redemption = undefined
}
