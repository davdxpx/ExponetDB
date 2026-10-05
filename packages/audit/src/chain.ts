import { AUDIT_EVENT_SCHEMA_ID } from '@exponetdb/contracts'
import {
  canonicalize,
  encodeUtf8,
  err,
  type InstallationId,
  isId,
  isJsonObject,
  type JsonError,
  type JsonValue,
  ok,
  type Result,
} from '@exponetdb/kernel'
import { sha256HexOf } from '@exponetdb/kernel/hash'

/**
 * The audit chain hash `ac1` ([audit.md §4.1](../../../exponetdb-docs/02-control-plane/audit.md#41-chain-hash-ac1),
 * [ADR-0023](../../../exponetdb-docs/01-architecture/adr/0023-audit-chain-hash-ac1.md)).
 * A stored contract from the first persisted event on: its output for an
 * input never changes; a change is `ac2` with its own vectors.
 *
 *   input = UTF8("exponetdb/audit-chain/ac1") LF
 *         + frame("prevHash", UTF8(prevHash))
 *         + frame("event",    UTF8(JCS(E)))
 *   frame(label, b) = UTF8(label) LF decimal(len(b)) LF b LF
 *   hash  = "sha256:ac1:" + lowercase hex(SHA-256(input))
 *
 * `prevHash` is the previous event's hash, or for `seq` 1 the genesis value
 * `ac1:genesis:<installation id>`, which binds the chain to its installation.
 * `E` is the event without `hash` and `prevHash`: exactly the members of
 * `exponetdb.audit/v1`. Checks run in a fixed order and the first failing one
 * is the refusal, so an implementation is testable against the golden
 * vectors in `tooling/golden/audit-chain.json`.
 */
export const AC1_DOMAIN = 'exponetdb/audit-chain/ac1'
export const AC1_HASH = /^sha256:ac1:[0-9a-f]{64}$/
const GENESIS = /^ac1:genesis:(ins_[0-7][0-9A-HJKMNP-TV-Z]{25})$/
const OCCURRED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

export const AUDIT_EVENT_REQUIRED = [
  'schema',
  'seq',
  'id',
  'occurredAt',
  'action',
  'phase',
  'actor',
] as const
export const AUDIT_EVENT_OPTIONAL = [
  'client',
  'subject',
  'refs',
  'reason',
  'decision',
  'result',
  'request',
  'changes',
] as const
const ALLOWED: ReadonlySet<string> = new Set([...AUDIT_EVENT_REQUIRED, ...AUDIT_EVENT_OPTIONAL])

export type AuditHashRefusal =
  | 'invalid_prev_hash'
  | 'not_object'
  | 'unknown_member'
  | 'missing_member'
  | 'unsupported_schema'
  | 'invalid_seq'
  | 'genesis_mismatch'
  | 'invalid_event_id'
  | 'invalid_timestamp'
  | JsonError['code']

export interface AuditHashError {
  readonly code: AuditHashRefusal
  readonly member?: string
}

export function genesisPrevHash(installationId: InstallationId): string {
  return `ac1:genesis:${installationId}`
}

export function isGenesis(prevHash: string): boolean {
  return GENESIS.test(prevHash)
}

function frame(label: string, bytes: Uint8Array): Uint8Array[] {
  return [encodeUtf8(`${label}\n${bytes.length}\n`), bytes, encodeUtf8('\n')]
}

export interface ChainHash {
  /** JCS of the event: the exact text that is stored and hashed. */
  readonly canonical: string
  readonly hash: string
}

/** Computes `ac1(prevHash, event)` after checking the envelope of the event. */
export function auditChainHash(
  prevHash: string,
  event: JsonValue,
): Result<ChainHash, AuditHashError> {
  const genesis = GENESIS.test(prevHash)
  if (!genesis && !AC1_HASH.test(prevHash)) {
    return err({ code: 'invalid_prev_hash' })
  }
  if (!isJsonObject(event)) {
    return err({ code: 'not_object' })
  }
  for (const name of Object.keys(event).sort()) {
    if (!ALLOWED.has(name)) {
      return err({ code: 'unknown_member', member: name })
    }
  }
  for (const name of AUDIT_EVENT_REQUIRED) {
    if (!Object.hasOwn(event, name)) {
      return err({ code: 'missing_member', member: name })
    }
  }
  if (event['schema'] !== AUDIT_EVENT_SCHEMA_ID) {
    return err({ code: 'unsupported_schema' })
  }
  const seq = event['seq']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    return err({ code: 'invalid_seq' })
  }
  if ((seq === 1) !== genesis) {
    return err({ code: 'genesis_mismatch' })
  }
  if (!isId('aud', event['id'])) {
    return err({ code: 'invalid_event_id' })
  }
  const occurredAt = event['occurredAt']
  if (typeof occurredAt !== 'string' || !OCCURRED_AT.test(occurredAt)) {
    return err({ code: 'invalid_timestamp' })
  }
  const canonical = canonicalize(event)
  if (!canonical.ok) {
    return err({ code: canonical.error.code })
  }
  const hash = sha256HexOf([
    encodeUtf8(`${AC1_DOMAIN}\n`),
    ...frame('prevHash', encodeUtf8(prevHash)),
    ...frame('event', encodeUtf8(canonical.value)),
  ])
  return ok({ canonical: canonical.value, hash: `sha256:ac1:${hash}` })
}
