/**
 * The full page loads the sign-in, link and account pages start: after a
 * sign-in or a finished enrollment the browser loads the next page from the
 * server, so nothing held in memory before the session existed (the query
 * cache, a form, a one-time token) carries over. The destination is always a
 * fixed path or the result of `safeReturnTo` (an exact allowlist), never text
 * from a response. An object, so tests can observe it (jsdom cannot
 * navigate).
 */
export const pageLoad = {
  assign(path: string): void {
    window.location.assign(path)
  },
}
