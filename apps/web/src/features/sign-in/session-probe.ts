import type { ApiClient, ResponseOf } from '../../lib/api/client.ts'

/**
 * Whether this browser already holds a session, asked once by the sign-in
 * page (a signed-in person who opens it goes on at once, as on the Wave 3A
 * page). It asks through the page's own API client: on the sign-in page an
 * answer of "no session" only drops the query cache (`leaveForSignIn` never
 * loads a page without a session again), so nothing loops. Any failure
 * (signed out, an expired session, the server unreachable) means the page
 * shows its form: the answer only decides whether to skip it.
 */
export type Me = ResponseOf<'getMe'>

export async function probeSession(
  client: Pick<ApiClient, 'operation'>,
  signal?: AbortSignal,
): Promise<Me | undefined> {
  try {
    return await client.operation('getMe', signal === undefined ? {} : { signal })
  } catch {
    return undefined
  }
}
