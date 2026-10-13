import type { ApiClient } from './client.ts'
import { ApiError, canceledError } from './errors.ts'

/**
 * Re-authentication around an action (ADR-0026, identity.md §8): when the
 * server answers `REAUTH_REQUIRED`, the page asks the person for a fresh
 * passkey or authenticator proof (`confirmIdentity`, the dialog), with every other
 * request paused (`RequestGate.exclusive`), then runs the action **once**
 * more. A canceled confirmation is `REAUTH_CANCELED` ("Canceled. Nothing
 * was changed."). The window is decided and checked by the server only.
 */
export type ConfirmIdentity = (client: ApiClient) => Promise<boolean>

export async function withReauth<T>(
  client: ApiClient,
  confirmIdentity: ConfirmIdentity,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'REAUTH_REQUIRED') {
      throw error
    }
  }
  const confirmed = await client.gate.exclusive(() => confirmIdentity(client))
  if (!confirmed) {
    throw canceledError()
  }
  return action()
}
