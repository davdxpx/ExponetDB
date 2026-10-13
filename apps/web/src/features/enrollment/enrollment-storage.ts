import type { EnrollmentState } from '@exponetdb/contracts'
import type { LinkPage } from '../../lib/navigation/links.ts'

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

/** The kind of enrollment each link page serves. */
export const ENROLLMENT_KIND: Readonly<Record<LinkPage, EnrollmentState['kind']>> = {
  '/setup': 'setup',
  '/invite': 'invitation',
  '/recover': 'recovery',
}

/** Whether a remembered value has exactly the shape the page renders. */
function isEnrollmentState(value: EnrollmentState): boolean {
  const steps: unknown = value.steps
  return (
    Object.values(ENROLLMENT_KIND).includes(value.kind) &&
    typeof value.email === 'string' &&
    typeof value.expiresAt === 'string' &&
    typeof value.complete === 'boolean' &&
    typeof steps === 'object' &&
    steps !== null &&
    typeof value.steps.passkey === 'boolean' &&
    typeof value.steps.password === 'boolean' &&
    typeof value.steps.totp === 'boolean'
  )
}

/** This tab's `sessionStorage`, or undefined where the browser refuses it. */
function tabStorage(): StorageLike | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/** Keeps the progress of the enrollment in this tab (never the token). */
export function saveProgress(state: EnrollmentState): void {
  const storage = tabStorage()
  if (storage !== undefined) rememberEnrollment(storage, state)
}

/**
 * The progress remembered in this tab for the enrollment `page` serves: a
 * value of another kind (an invitation's progress on the recovery page) or
 * of another shape counts as nothing remembered.
 */
export function loadProgress(page: LinkPage): EnrollmentState | undefined {
  const storage = tabStorage()
  const state = storage === undefined ? undefined : rememberedEnrollment(storage)
  if (state === undefined || !isEnrollmentState(state) || state.kind !== ENROLLMENT_KIND[page]) {
    return undefined
  }
  return state
}

/** Forgets the progress once the enrollment finished. */
export function clearProgress(): void {
  const storage = tabStorage()
  if (storage !== undefined) forgetEnrollment(storage)
}
