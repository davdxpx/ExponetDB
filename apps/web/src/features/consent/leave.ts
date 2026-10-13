/**
 * Leaving the app for the client after a decision (oauth.md §4): the
 * server answers with the client's own redirect (its registered address
 * with the code or `error=access_denied`), and the browser goes there. The
 * page never builds that address itself and never renders it as a link;
 * it only refuses anything that is not an `http(s)` URL, so a broken
 * answer can never run as a `javascript:` or `data:` navigation.
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url)
  },
}

/** Whether `url` is an absolute `https:` or `http:` URL the browser may open. */
export function isLeavableUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
}

/** Opens the client's redirect; returns false (and opens nothing) when it is not leavable. */
export function leaveTo(url: string): boolean {
  if (!isLeavableUrl(url)) return false
  browserNavigation.assign(url)
  return true
}
