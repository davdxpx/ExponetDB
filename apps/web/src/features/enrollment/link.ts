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
