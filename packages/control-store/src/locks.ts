import { sha256 } from '@exponetdb/kernel/hash'

/**
 * Advisory lock keys ([concurrency.md §2](../../../exponetdb-docs/04-migrations/concurrency.md#2-lock-scope-and-key-derivation)).
 * The int4 pair form: `key1` is the ExponetDB namespace `EXDB`
 * (0x45584442 = 1163412546), fixed forever; `key2` is the first four bytes,
 * big-endian and signed, of SHA-256 over a versioned name. The Control
 * Store's own locks use the class `control-store`, so they cannot collide
 * with target lock classes in meaning (targets never share a database with
 * the Control Store, C-5).
 */
export const EXDB_LOCK_NAMESPACE = 1163412546

export function lockKey2(name: string): number {
  const digest = sha256(`exponetdb/lock/v1/${name}`)
  return new DataView(digest.buffer, digest.byteOffset, 4).getInt32(0, false)
}

/** Session lock held by `exponetdb control-store migrate` for its whole run. */
export const MIGRATE_LOCK = {
  key1: EXDB_LOCK_NAMESPACE,
  key2: lockKey2('control-store/migrate'),
} as const

/** Transaction lock that serializes audit chain appends (one linear chain per installation). */
export const AUDIT_CHAIN_LOCK = {
  key1: EXDB_LOCK_NAMESPACE,
  key2: lockKey2('control-store/audit-chain'),
} as const

/** Session lock the test harness takes while it (re)creates cluster roles. */
export const TEST_ROLES_LOCK = {
  key1: EXDB_LOCK_NAMESPACE,
  key2: lockKey2('control-store/test-roles'),
} as const

/**
 * Transaction lock that serializes every change able to remove an active
 * owner (the last-owner invariant, Wave 3A). The Control Store's trigger
 * `auth.owner_invariant` takes the same key (`1792970966`).
 */
export const OWNER_INVARIANT_LOCK = {
  key1: EXDB_LOCK_NAMESPACE,
  key2: lockKey2('control-store/owner-invariant'),
} as const

/** Transaction lock of the first-owner bootstrap command (issue and re-issue of the setup link). */
export const BOOTSTRAP_OWNER_LOCK = {
  key1: EXDB_LOCK_NAMESPACE,
  key2: lockKey2('control-store/bootstrap-owner'),
} as const
