import { ApiClient, type ResponseOf } from '../../lib/api/client.ts'

/**
 * Whether this browser already holds a session, asked once by the sign-in
 * page (a signed-in person who opens it goes on at once, as on the Wave 3A
 * page). The page's own API client leaves for the sign-in page whenever the
 * server says the session is gone, which on the sign-in page itself would
 * load it again and again; so the probe asks through a client of the same
 * kind whose only difference is that it does nothing then. Any failure
 * (signed out, an expired session, the server unreachable) means the page
 * shows its form: the answer only decides whether to skip it.
 */
export type Me = ResponseOf<'getMe'>

export interface ProbeDeps {
  readonly fetch: typeof fetch
  readonly cookies: () => string
}

const browserDeps: ProbeDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  cookies: () => document.cookie,
}

export async function probeSession(
  signal?: AbortSignal,
  deps: ProbeDeps = browserDeps,
): Promise<Me | undefined> {
  const client = new ApiClient({
    fetch: deps.fetch,
    cookies: deps.cookies,
    onSessionGone: () => undefined,
  })
  try {
    return await client.operation('getMe', signal === undefined ? {} : { signal })
  } catch {
    return undefined
  }
}
