import type { EnrollmentState } from '@exponetdb/contracts'

/**
 * The enrollment's progress in `sessionStorage` (this tab only), so a reload
 * keeps the steps a person already finished in view. It never holds the
 * link's token: the server keeps the ceremony in the `__Host-exdb_ceremony`
 * cookie and refuses anything out of order, so what is stored here is shown
 * only. Without storage a reload asks for a new link.
 */
export const ENROLLMENT_KEY = 'exdb.enrollment'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function rememberEnrollment(storage: StorageLike, state: EnrollmentState): void {
  try {
    storage.setItem(ENROLLMENT_KEY, JSON.stringify(state))
  } catch {
    // Without storage a reload asks for a new link; nothing else depends on it.
  }
}

export function rememberedEnrollment(storage: StorageLike): EnrollmentState | undefined {
  try {
    const text = storage.getItem(ENROLLMENT_KEY)
    const value: unknown = text === null ? undefined : JSON.parse(text)
    if (typeof value === 'object' && value !== null && 'steps' in value && 'email' in value) {
      // Shown only; the server holds the real state.
      return value as EnrollmentState
    }
  } catch {
    return undefined
  }
  return undefined
}

export function forgetEnrollment(storage: StorageLike): void {
  try {
    storage.removeItem(ENROLLMENT_KEY)
  } catch {
    // Nothing to clean up.
  }
}
