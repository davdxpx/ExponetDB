import { ApiError } from '../../lib/api/errors.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import type { Me } from './account-model.ts'

/**
 * The own profile (Wave 8, owner decision S10; identity.md §12) as pure
 * functions: the fields `GET /me` carries beside the identity, the name and
 * initials to show, the picture address (only the same-origin path the
 * server names, never anything else), the checks made before a file is sent
 * and the sentence for each reason the server refuses a picture.
 *
 * The generated SDK types carry these fields once it is regenerated; until
 * then they are read from the answer through this one type.
 */
export interface AvatarRef {
  readonly url: string
  readonly sha256: string
  readonly width: number
  readonly height: number
}

export interface ProfileFields {
  readonly displayName?: string | null
  readonly avatar?: AvatarRef | null
  readonly profileRevision?: number
}

export type ProfileMe = Me & ProfileFields

/** The profile as the write calls answer it. */
export interface ProfileView {
  readonly identityId: string
  readonly displayName: string | null
  readonly avatar: AvatarRef | null
  readonly revision: number
  readonly updatedAt: string | null
}

export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const AVATAR_MAX_BYTES = 256 * 1024
export const DISPLAY_NAME_MAX = 64

/** The own profile and the own picture. */
export const PROFILE_PATH = '/api/v1/me/profile'
export const AVATAR_PATH = '/api/v1/me/avatar'

/** The one shape of a picture address: a path of this origin, never a host. */
const AVATAR_URL =
  /^\/api\/v1\/identities\/idn_[0-7][0-9A-HJKMNP-TV-Z]{25}\/avatar\?v=sha256:[0-9a-f]{64}$/

/** The picture address to load, or undefined: anything but the server's same-origin path is ignored. */
export function avatarSrcOf(avatar: AvatarRef | null | undefined): string | undefined {
  if (avatar === null || avatar === undefined) return undefined
  return AVATAR_URL.test(avatar.url) ? avatar.url : undefined
}

/** The name the person chose, else the one from the invitation, else the address, else the audit label. */
export function displayNameOf(me: ProfileMe): string {
  const chosen = me.displayName
  if (typeof chosen === 'string' && chosen !== '') return chosen
  return me.identity.displayName ?? me.identity.email ?? me.identity.label
}

export function profileRevisionOf(me: ProfileMe): number {
  return me.profileRevision ?? 0
}

/**
 * One or two capital letters for the neutral tile: the first letter or digit
 * of the first two words of the name (of the part before the `@` for an
 * address). Only letters and digits count, so hidden and direction
 * characters never reach the tile; nothing usable shows `?`.
 */
export function initialsOf(source: string): string {
  const base = source.includes('@') ? source.slice(0, source.indexOf('@')) : source
  const words = base.split(/[\s._+-]+/u)
  const letters: string[] = []
  for (const word of words) {
    const first = Array.from(word).find((char) => /^[\p{L}\p{N}]$/u.test(char))
    if (first !== undefined) letters.push(first.toLocaleUpperCase())
    if (letters.length === 2) break
  }
  return letters.length === 0 ? '?' : letters.join('')
}

/** The reasons a picture is refused: by the browser before sending, or by the server (`422`). */
export type AvatarReason =
  | 'unsupported_format'
  | 'type_mismatch'
  | 'malformed'
  | 'animated'
  | 'dimensions'
  | 'trailing_data'
  | 'too_large'
  | 'empty'

/** The checks made in the browser before a file is sent; the server repeats and extends them. */
export function checkAvatarFile(file: {
  readonly type: string
  readonly size: number
}): AvatarReason | undefined {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) return 'unsupported_format'
  if (file.size === 0) return 'empty'
  if (file.size > AVATAR_MAX_BYTES) return 'too_large'
  return undefined
}

const REASONS: Readonly<Record<AvatarReason, MessageKey>> = {
  unsupported_format: 'profile.picture.reason.unsupported_format',
  type_mismatch: 'profile.picture.reason.type_mismatch',
  malformed: 'profile.picture.reason.malformed',
  animated: 'profile.picture.reason.animated',
  dimensions: 'profile.picture.reason.dimensions',
  trailing_data: 'profile.picture.reason.trailing_data',
  too_large: 'profile.picture.reason.too_large',
  empty: 'profile.picture.reason.empty',
}

export function reasonSentence(reason: AvatarReason): string {
  return t(REASONS[reason])
}

function isReason(value: unknown): value is AvatarReason {
  return typeof value === 'string' && Object.hasOwn(REASONS, value)
}

/**
 * The sentence for a `422` on the picture (`details.errors[].code`), or
 * undefined when the error is something else: the page then shows the
 * catalog error. A `422` with a reason this page does not know reads as the
 * general sentence, never as the server's text.
 */
export function refusalOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.status !== 422) return undefined
  const details = error.details
  const errors =
    typeof details === 'object' && details !== null && 'errors' in details
      ? (details as { readonly errors: unknown }).errors
      : undefined
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const code =
        typeof entry === 'object' && entry !== null && 'code' in entry
          ? (entry as { readonly code: unknown }).code
          : undefined
      if (isReason(code)) return reasonSentence(code)
    }
  }
  return t('profile.picture.reason.unknown')
}
