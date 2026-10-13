/**
 * The CSRF token of the session: the readable `__Host-exdb_csrf` cookie,
 * read fresh for every request because the server rotates it with the
 * session at every re-authentication. Never cached, never stored.
 */
export const CSRF_COOKIE = '__Host-exdb_csrf'
export const CSRF_HEADER = 'x-csrf-token'

const TOKEN = /^[A-Za-z0-9_-]{1,128}$/

/** The CSRF token from a `document.cookie` string, or undefined when absent or malformed. */
export function readCsrf(cookies: string): string | undefined {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === CSRF_COOKIE) {
      const value = part.slice(eq + 1).trim()
      return TOKEN.test(value) ? value : undefined
    }
  }
  return undefined
}
