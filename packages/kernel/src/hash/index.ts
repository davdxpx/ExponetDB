import { createHash } from 'node:crypto'
import { isId } from '../ids.ts'
import { canonicalBytes } from '../jcs.ts'
import type { JsonObject, JsonValue } from '../json.ts'
import { isJsonObject } from '../json.ts'
import { err, ok, type Result } from '../result.ts'
import { encodeUtf8 } from '../utf8.ts'

/**
 * SHA-256 primitives (Node.js `crypto`). This subpath is separate from the
 * kernel root so that browser bundles of contract types never pull in
 * `node:crypto`.
 */
export function sha256(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data
  return new Uint8Array(createHash('sha256').update(bytes).digest())
}

/** Lowercase hexadecimal SHA-256. */
export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data
  return createHash('sha256').update(bytes).digest('hex')
}

/** Incremental SHA-256 over a sequence of byte chunks. */
export function sha256HexOf(chunks: readonly Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const chunk of chunks) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/** Binding members of a plan ([operations-engine.md §3.1](../../../../exponetdb-docs/02-control-plane/operations-engine.md#31-content)). */
export const PLAN_HASH_REQUIRED_MEMBERS = [
  'id',
  'kind',
  'kindVersion',
  'createdAt',
  'expiresAt',
  'actor',
  'client',
  'subject',
  'content',
  'contentChecksum',
  'policy',
] as const

export const PLAN_HASH_OPTIONAL_MEMBERS = ['expectedState', 'analysis', 'evidence'] as const

const allowedMembers: ReadonlySet<string> = new Set<string>([
  ...PLAN_HASH_REQUIRED_MEMBERS,
  ...PLAN_HASH_OPTIONAL_MEMBERS,
])

export type PlanHashRefusal =
  | 'unknown_member'
  | 'missing_member'
  | 'invalid_plan_id'
  | 'not_json'
  | 'invalid_json'
  | 'duplicate_member'
  | 'lone_surrogate'
  | 'number_not_finite'
  | 'nesting_too_deep'

export interface PlanHashError {
  readonly code: PlanHashRefusal
  readonly member?: string
}

/**
 * `planHash = "sha256:" + hex(SHA-256(JCS(B)))` where `B` holds exactly the
 * plan's binding members. Refuses unknown members (so a new binding field
 * cannot silently stay outside the hash), missing required members and an id
 * that is not a canonical `pln_` id, in that order.
 */
export function computePlanHash(body: JsonValue): Result<string, PlanHashError> {
  if (!isJsonObject(body)) {
    return err({ code: 'not_json' })
  }
  const names = Object.keys(body).sort()
  for (const name of names) {
    if (!allowedMembers.has(name)) {
      return err({ code: 'unknown_member', member: name })
    }
  }
  for (const name of PLAN_HASH_REQUIRED_MEMBERS) {
    if (!Object.hasOwn(body, name)) {
      return err({ code: 'missing_member', member: name })
    }
  }
  if (!isId('pln', body['id'])) {
    return err({ code: 'invalid_plan_id' })
  }
  const bytes = canonicalBytes(body)
  if (!bytes.ok) {
    return err({ code: bytes.error.code })
  }
  return ok(`sha256:${sha256Hex(bytes.value)}`)
}

export type { JsonObject }
