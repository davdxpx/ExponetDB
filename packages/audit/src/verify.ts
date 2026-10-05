import { StoredAuditEventSchema } from '@exponetdb/contracts'
import type { Queryable } from '@exponetdb/control-store'
import { canonicalize, isId, parseJson } from '@exponetdb/kernel'
import { auditChainHash, genesisPrevHash } from './chain.ts'

/**
 * `exponetdb audit verify` (audit.md §4.5): recomputes the chain and reports
 * the first event that does not hold. Read-only: there is no repair mode.
 *
 * Per event, in seq order: the sequence has no gap, `prev_hash` is the
 * previous event's hash (or the anchor the walk started from), the stored
 * text is canonical JCS and a valid `exponetdb.audit/v1` event, its query
 * columns match it, and its hash is `ac1(prev_hash, event)`.
 *
 * Starting points: the genesis value of the installation (`seq` 1), a
 * checkpoint (its `(seq, hash)` must match the stored event), or, after a
 * retention purge removed the oldest events, the boundary recorded in the
 * `retention.pruned` event.
 */
export type ChainFailureReason =
  | 'empty_chain'
  | 'anchor_missing'
  | 'checkpoint_mismatch'
  | 'sequence_gap'
  | 'prev_hash_mismatch'
  | 'not_canonical'
  | 'invalid_event'
  | 'columns_mismatch'
  | 'hash_mismatch'

export type ChainVerification =
  | {
      readonly ok: true
      readonly fromSeq: number
      readonly lastSeq: number
      readonly lastHash: string
      readonly verifiedEvents: number
    }
  | {
      readonly ok: false
      readonly firstFailingSeq: number
      readonly reason: ChainFailureReason
      readonly verifiedEvents: number
    }

export interface VerifyOptions {
  /** Start after this checkpoint instead of at the oldest event. */
  readonly fromCheckpointSeq?: number
  readonly batchSize?: number
}

interface Anchor {
  readonly nextSeq: number
  readonly prevHash: string
}

async function startingAnchor(
  q: Queryable,
  options: VerifyOptions,
): Promise<Anchor | ChainVerification> {
  if (options.fromCheckpointSeq !== undefined) {
    const { rows } = await q.query(
      'audit.verify.checkpoint',
      `SELECT c.seq, c.hash, a.hash AS event_hash
         FROM audit.audit_chain_checkpoints c LEFT JOIN audit.audit_events a ON a.seq = c.seq
        WHERE c.seq = $1`,
      [options.fromCheckpointSeq],
    )
    const row = rows[0]
    if (row === undefined) {
      return {
        ok: false,
        firstFailingSeq: options.fromCheckpointSeq,
        reason: 'anchor_missing',
        verifiedEvents: 0,
      }
    }
    if (row.textOrNull('event_hash') !== row.text('hash')) {
      return {
        ok: false,
        firstFailingSeq: row.int('seq'),
        reason: 'checkpoint_mismatch',
        verifiedEvents: 0,
      }
    }
    return { nextSeq: row.int('seq') + 1, prevHash: row.text('hash') }
  }
  const oldest = await q.query(
    'audit.verify.oldest',
    'SELECT min(seq) AS seq FROM audit.audit_events',
  )
  const first = oldest.rows[0]?.intOrNull('seq') ?? null
  if (first === null) {
    return { ok: false, firstFailingSeq: 0, reason: 'empty_chain', verifiedEvents: 0 }
  }
  if (first === 1) {
    const inst = await q.query(
      'audit.verify.installation',
      'SELECT installation_id FROM control.installation',
    )
    const installationId = inst.rows[0]?.text('installation_id')
    if (!isId('ins', installationId)) {
      return { ok: false, firstFailingSeq: 1, reason: 'anchor_missing', verifiedEvents: 0 }
    }
    return { nextSeq: 1, prevHash: genesisPrevHash(installationId) }
  }
  // Oldest events were pruned: the boundary is recorded in a retention.pruned event.
  const pruned = await q.query(
    'audit.verify.pruned_anchor',
    `SELECT event FROM audit.audit_events
      WHERE action = 'retention.pruned' AND (event::jsonb -> 'refs' ->> 'droppedThroughSeq')::bigint = $1
      ORDER BY seq LIMIT 1`,
    [first - 1],
  )
  const text = pruned.rows[0]?.text('event')
  const json = text === undefined ? undefined : parseJson(text)
  const parsed = json?.ok === true ? StoredAuditEventSchema.safeParse(json.value) : undefined
  const boundary = parsed?.success === true ? parsed.data.refs?.boundaryHash : undefined
  if (boundary === undefined) {
    return { ok: false, firstFailingSeq: first, reason: 'anchor_missing', verifiedEvents: 0 }
  }
  return { nextSeq: first, prevHash: boundary }
}

export async function verifyAuditChain(
  q: Queryable,
  options: VerifyOptions = {},
): Promise<ChainVerification> {
  const anchor = await startingAnchor(q, options)
  if ('ok' in anchor) {
    return anchor
  }
  const batchSize = options.batchSize ?? 1000
  let expectedSeq = anchor.nextSeq
  let prevHash = anchor.prevHash
  let verified = 0
  for (;;) {
    const { rows } = await q.query(
      'audit.verify.batch',
      `SELECT seq, occurred_at, event_id, action, phase, actor_kind, actor_id, operation_id, plan_id,
              event, prev_hash, hash
         FROM audit.audit_events WHERE seq >= $1 ORDER BY seq LIMIT $2`,
      [expectedSeq, batchSize],
    )
    if (rows.length === 0) {
      break
    }
    for (const row of rows) {
      const seq = row.int('seq')
      const fail = (reason: ChainFailureReason): ChainVerification => ({
        ok: false,
        firstFailingSeq: seq === expectedSeq ? seq : expectedSeq,
        reason,
        verifiedEvents: verified,
      })
      if (seq !== expectedSeq) {
        return fail('sequence_gap')
      }
      if (row.text('prev_hash') !== prevHash) {
        return fail('prev_hash_mismatch')
      }
      const text = row.text('event')
      const json = parseJson(text)
      if (!json.ok) {
        return fail('not_canonical')
      }
      const canonical = canonicalize(json.value)
      if (!canonical.ok || canonical.value !== text) {
        return fail('not_canonical')
      }
      const event = StoredAuditEventSchema.safeParse(json.value)
      if (!event.success) {
        return fail('invalid_event')
      }
      const e = event.data
      if (
        e.seq !== seq ||
        e.id !== row.text('event_id') ||
        e.action !== row.text('action') ||
        e.phase !== row.text('phase') ||
        e.actor.kind !== row.text('actor_kind') ||
        e.actor.identityId !== row.textOrNull('actor_id') ||
        (e.refs?.operationId ?? null) !== row.textOrNull('operation_id') ||
        (e.refs?.planId ?? null) !== row.textOrNull('plan_id') ||
        Date.parse(e.occurredAt) !== row.date('occurred_at').getTime()
      ) {
        return fail('columns_mismatch')
      }
      const hash = auditChainHash(prevHash, json.value)
      if (!hash.ok || hash.value.hash !== row.text('hash')) {
        return fail('hash_mismatch')
      }
      prevHash = hash.value.hash
      expectedSeq = seq + 1
      verified += 1
    }
  }
  if (verified === 0 && options.fromCheckpointSeq === undefined) {
    return { ok: false, firstFailingSeq: anchor.nextSeq, reason: 'empty_chain', verifiedEvents: 0 }
  }
  return {
    ok: true,
    fromSeq: anchor.nextSeq,
    lastSeq: expectedSeq - 1,
    lastHash: prevHash,
    verifiedEvents: verified,
  }
}
