import { createHash } from 'node:crypto'
import { appendAuditEvent } from '@exponetdb/audit'
import type { Authorization, SubjectRef } from '@exponetdb/auth'
import {
  type AuditEventInput,
  type AvatarMediaType,
  type AvatarRef,
  ProfileDisplayNameSchema,
  type ProfileUpdateRequest,
  type ProfileView,
  REST_API_BASE_PATH,
} from '@exponetdb/contracts'
import {
  type ControlStore,
  ControlStoreError,
  type Queryable,
  type Row,
  type Tx,
} from '@exponetdb/control-store'
import type { Clock, IdentityId } from '@exponetdb/kernel'
import { RegistryError } from '@exponetdb/registry'
import { type AvatarRefusal, checkAvatarImage } from './avatar-image.ts'
import type { ReadParties } from './queries.ts'
import type { CallerLike } from './registry.ts'

/**
 * The profile of a person (Wave 8, owner decision S10 of 2026-10-13;
 * identity.md §12): a display name of their own choosing and a profile
 * picture, kept in the Control Store (`profiles.identity_profiles`).
 *
 * - Changes are a person's own records, made in the Web App (self-service
 *   actions with the session's `api` scope); no re-authentication
 *   (identity.md §4 lists none for a profile); a recovery session cannot.
 *   The Control Store enforces the same shape (one row per identity, a
 *   revision that grows by one, only an active person) through
 *   security-definer functions; `serve` holds no write right on the table.
 * - The name is untrusted text: bounded, one line, no control or
 *   bidirectional formatting character, shown and never interpreted.
 * - A picture is checked from its bytes (`avatar-image.ts`), stored with its
 *   hash, and served same-origin under an address keyed by that hash.
 * - The audit records each change with the revision and, for a picture, its
 *   hash, size, type and dimensions; never the name and never the bytes
 *   (audit.md §6: the audit cannot be erased, the profile can).
 * - Erasure deletes the profile (the worker's `access.identity.erase`).
 */
export interface ProfileHost {
  readonly store: ControlStore
  readonly clock: Clock
  authorize(
    q: Queryable,
    action: string,
    caller: CallerLike,
    subject: SubjectRef,
  ): Promise<Authorization>
  /** The engine's decision without throwing and without a denial event. */
  allowed(q: Queryable, action: string, caller: CallerLike, subject: SubjectRef): Promise<boolean>
  parties(caller: CallerLike): ReadParties
}

export interface StoredAvatar {
  readonly mediaType: AvatarMediaType
  readonly sha256: string
  readonly width: number
  readonly height: number
  readonly bytes: number
}

export interface StoredProfile {
  readonly identityId: string
  readonly displayName: string | null
  readonly avatar: StoredAvatar | null
  readonly revision: number
  readonly updatedAt: Date
}

/** A picture to serve: the stored bytes and media type. */
export interface AvatarContent {
  readonly bytes: Uint8Array
  readonly mediaType: AvatarMediaType
  readonly sha256: string
}

const COLUMNS = `identity_id, display_name, avatar_media_type, avatar_sha256, avatar_width,
                 avatar_height, octet_length(avatar) AS avatar_bytes, revision, updated_at`

function mediaTypeOf(value: string): AvatarMediaType {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp') return value
  throw new ControlStoreError('control_store_invalid_result')
}

function stored(row: Row): StoredProfile {
  const type = row.textOrNull('avatar_media_type')
  return {
    identityId: row.text('identity_id'),
    displayName: row.textOrNull('display_name'),
    avatar:
      type === null
        ? null
        : {
            mediaType: mediaTypeOf(type),
            sha256: row.text('avatar_sha256'),
            width: row.int('avatar_width'),
            height: row.int('avatar_height'),
            bytes: row.int('avatar_bytes'),
          },
    revision: row.int('revision'),
    updatedAt: row.date('updated_at'),
  }
}

/** The same-origin address of a picture, keyed by its hash (a new picture is a new address). */
export function avatarRef(identityId: string, avatar: StoredAvatar | null): AvatarRef | null {
  if (avatar === null) return null
  return {
    url: `${REST_API_BASE_PATH}/identities/${identityId}/avatar?v=${avatar.sha256}`,
    sha256: avatar.sha256,
    width: avatar.width,
    height: avatar.height,
  } as AvatarRef
}

/**
 * The profiles of these identities (missing ones have none). Called by
 * use cases that already authorized the read of those identities.
 */
export async function readProfiles(
  q: Queryable,
  identityIds: readonly string[],
): Promise<Map<string, StoredProfile>> {
  if (identityIds.length === 0) return new Map()
  const { rows } = await q.query(
    'application.profile.read',
    `SELECT ${COLUMNS} FROM profiles.identity_profiles WHERE identity_id = ANY($1::text[])`,
    [[...new Set(identityIds)]],
  )
  return new Map(rows.map((row) => [row.text('identity_id'), stored(row)] as const))
}

/** The REST view of a person's own profile (revision 0 while there is none). */
export function profileView(identityId: string, profile: StoredProfile | undefined): ProfileView {
  return {
    identityId,
    displayName: profile?.displayName ?? null,
    avatar: avatarRef(identityId, profile?.avatar ?? null),
    revision: profile?.revision ?? 0,
    updatedAt: profile === undefined ? null : profile.updatedAt.toISOString(),
  } as ProfileView
}

const REFUSALS: Readonly<Record<AvatarRefusal, string>> = {
  empty: 'The picture is empty.',
  too_large: 'A picture of at most 256 KiB.',
  unsupported_format: 'A PNG, JPEG (baseline or progressive) or WebP picture only.',
  type_mismatch: 'The picture is not of the declared media type.',
  malformed: 'The picture is incomplete or not well formed.',
  animated: 'An animated picture is not accepted.',
  dimensions: 'A picture of 32 to 1024 pixels in width and in height.',
  trailing_data: 'The picture carries data after its end.',
}

function refused(reason: AvatarRefusal): RegistryError {
  return new RegistryError('VALIDATION_FAILED', {
    errors: [{ path: '/body', code: reason, message: REFUSALS[reason] }],
  })
}

function sqlstate(error: unknown): string | undefined {
  return error instanceof ControlStoreError ? error.sqlstate : undefined
}

/** A refusal of the store: a stale revision is CONFLICT; an identity that is no active person cannot change. */
function storeRefusal(error: unknown): never {
  const state = sqlstate(error)
  if (state === 'EXF03') throw new RegistryError('CONFLICT')
  if (state === 'EXF02') throw new RegistryError('PERMISSION_DENIED')
  throw error
}

export class ProfileUseCases {
  readonly #h: ProfileHost

  constructor(host: ProfileHost) {
    this.#h = host
  }

  /** The caller's own identity, after the engine allowed the self-service action. */
  async #self(q: Queryable, action: string, caller: CallerLike): Promise<IdentityId> {
    const identityId = this.#h.parties(caller).actor.identityId
    await this.#h.authorize(q, action, caller, { kind: 'self', identityId })
    return identityId
  }

  async #load(q: Queryable, identityId: string): Promise<StoredProfile | undefined> {
    return (await readProfiles(q, [identityId])).get(identityId)
  }

  /** The audit of a change: the revision and, for a picture, its hash, size, type and dimensions. */
  async #audit(
    tx: Tx,
    caller: CallerLike,
    action: 'me.profile.update' | 'me.avatar.set' | 'me.avatar.delete',
    changes: Readonly<Record<string, string | number | boolean>>,
    requestId: string,
  ): Promise<void> {
    const parties = this.#h.parties(caller)
    const event: AuditEventInput = {
      action,
      phase: 'completed',
      actor: {
        kind: parties.actor.kind,
        identityId: parties.actor.identityId,
        label: parties.actor.label as never,
      },
      client: {
        clientId: parties.client.clientId as never,
        kind: parties.client.kind,
        grantId: parties.client.grantId as never,
        ...(parties.client.sessionId === undefined
          ? {}
          : { sessionId: parties.client.sessionId as never }),
      },
      request: { requestId: requestId as never },
      changes,
      result: { status: 'succeeded' },
    }
    await appendAuditEvent(tx, event, { clock: this.#h.clock })
  }

  /** `PUT /me/profile`: the display name (null clears it) at the revision it is based on. */
  async updateProfile(
    caller: CallerLike,
    body: ProfileUpdateRequest,
    options: { readonly requestId: string },
  ): Promise<ProfileView> {
    if (
      body.displayName !== null &&
      !ProfileDisplayNameSchema.safeParse(body.displayName).success
    ) {
      throw new RegistryError('VALIDATION_FAILED', {
        errors: [
          {
            path: '/displayName',
            code: 'invalid',
            message: 'One line of 1 to 64 characters without control or formatting characters.',
          },
        ],
      })
    }
    const store = this.#h.store
    try {
      return await store.transaction('application.profile.update', async (tx) => {
        const identityId = await this.#self(tx, 'me.profile.update', caller)
        const { rows } = await tx.query(
          'application.profile.set_display_name',
          'SELECT profiles.set_display_name($1, $2, $3) AS revision',
          [identityId, body.revision, body.displayName],
        )
        const revision = rows[0]?.int('revision')
        if (revision === undefined) throw new RegistryError('INTERNAL')
        // Whether a name is set, never the name (personal data, audit.md §6).
        await this.#audit(
          tx,
          caller,
          'me.profile.update',
          { revision, displayNameSet: body.displayName !== null },
          options.requestId,
        )
        return profileView(identityId, await this.#load(tx, identityId))
      })
    } catch (error) {
      return storeRefusal(error)
    }
  }

  /** `PUT /me/avatar`: a picture checked from its bytes, stored with its hash. */
  async setAvatar(
    caller: CallerLike,
    upload: { readonly bytes: Uint8Array; readonly mediaType: string },
    options: { readonly requestId: string },
  ): Promise<ProfileView> {
    const store = this.#h.store
    // Decided before the bytes are looked at: a caller who may not change a profile learns nothing.
    const identityId = await this.#self(store, 'me.avatar.set', caller)
    const check = checkAvatarImage(upload.bytes, upload.mediaType)
    if (!check.ok) throw refused(check.reason)
    // Stored, hashed and served without its metadata (GPS, camera, text; OD-8): the checked copy.
    const bytes = check.bytes
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    try {
      return await store.transaction('application.profile.avatar.set', async (tx) => {
        const { rows } = await tx.query(
          'application.profile.set_avatar',
          'SELECT profiles.set_avatar($1, $2, $3, $4, $5, $6) AS revision',
          [identityId, Buffer.from(bytes), check.mediaType, sha256, check.width, check.height],
        )
        const revision = rows[0]?.int('revision')
        if (revision === undefined) throw new RegistryError('INTERNAL')
        await this.#audit(
          tx,
          caller,
          'me.avatar.set',
          {
            revision,
            sha256,
            bytes: bytes.length,
            mediaType: check.mediaType,
            width: check.width,
            height: check.height,
          },
          options.requestId,
        )
        return profileView(identityId, await this.#load(tx, identityId))
      })
    } catch (error) {
      return storeRefusal(error)
    }
  }

  /** `DELETE /me/avatar`: removes the picture; nothing to remove changes and records nothing. */
  async deleteAvatar(
    caller: CallerLike,
    options: { readonly requestId: string },
  ): Promise<ProfileView> {
    const store = this.#h.store
    try {
      return await store.transaction('application.profile.avatar.delete', async (tx) => {
        const identityId = await this.#self(tx, 'me.avatar.delete', caller)
        const before = await this.#load(tx, identityId)
        const { rows } = await tx.query(
          'application.profile.clear_avatar',
          'SELECT profiles.clear_avatar($1) AS revision',
          [identityId],
        )
        const revision = rows[0]?.intOrNull('revision') ?? null
        if (revision !== null && before?.avatar != null) {
          await this.#audit(
            tx,
            caller,
            'me.avatar.delete',
            { revision, sha256: before.avatar.sha256 },
            options.requestId,
          )
        }
        return profileView(identityId, await this.#load(tx, identityId))
      })
    } catch (error) {
      return storeRefusal(error)
    }
  }

  /**
   * `GET /identities/{identityId}/avatar?v=`: the own picture (decided as
   * `me.get`) or anyone's with `access.read` (`identity.avatar.get`). A
   * caller who may read neither, an identity without a picture and a hash
   * that is not the current picture's all answer NOT_FOUND alike.
   */
  async avatar(caller: CallerLike, identityId: IdentityId, sha256: string): Promise<AvatarContent> {
    const store = this.#h.store
    const own = this.#h.parties(caller).actor.identityId === identityId
    const allowed =
      (own && (await this.#h.allowed(store, 'me.get', caller, { kind: 'self', identityId }))) ||
      (await this.#h.allowed(store, 'identity.avatar.get', caller, { kind: 'installation' }))
    if (!allowed) throw new RegistryError('NOT_FOUND')
    const { rows } = await store.query(
      'application.profile.avatar.get',
      `SELECT avatar, avatar_media_type, avatar_sha256 FROM profiles.identity_profiles
        WHERE identity_id = $1 AND avatar_sha256 = $2`,
      [identityId, sha256],
    )
    const [row] = rows
    if (row === undefined) throw new RegistryError('NOT_FOUND')
    return {
      bytes: row.bytes('avatar'),
      mediaType: mediaTypeOf(row.text('avatar_media_type')),
      sha256: row.text('avatar_sha256'),
    }
  }
}
