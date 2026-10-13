/**
 * The query string as the router reads and writes it: plain
 * `application/x-www-form-urlencoded` pairs, every value a string, nothing
 * parsed as JSON. The router's default reads JSON in query values, so
 * `?returnTo=%22%2Fapprovals%22` (the text `"/approvals"` with its quotes)
 * would come out as `/approvals`; here it stays `"/approvals"`, and the
 * allowlist it meets (`safeReturnTo`, `connectSearch`, `authorizeError`)
 * refuses it. Pages never trust a query value: they match it against an
 * exact allowlist, as they did before (threat-model.md, "Untrusted deep
 * links").
 *
 * A key given twice keeps its first value, as `URLSearchParams.get` does.
 */
export function parseSearch(search: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(search)) {
    if (!Object.hasOwn(values, key)) {
      Object.defineProperty(values, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
  }
  return values
}

/**
 * The query string of a search object the app builds: strings, numbers and
 * booleans as text; `undefined`, `null` and anything else are left out (no
 * route keeps structured values in its query). `?` plus the pairs, or `''`.
 */
export function stringifySearch(search: Readonly<Record<string, unknown>>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string') params.append(key, value)
    else if (typeof value === 'number' || typeof value === 'boolean') {
      params.append(key, String(value))
    }
  }
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}
