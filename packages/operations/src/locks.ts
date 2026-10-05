import type { Queryable, Tx } from '@exponetdb/control-store'
import { ControlStoreError } from '@exponetdb/control-store'
import { compareUtf8 } from '@exponetdb/kernel'
import { OperationError } from './errors.ts'

/**
 * Exclusivity domains ([operations-engine.md §7](../../../exponetdb-docs/02-control-plane/operations-engine.md#7-exclusivity-domains)).
 * One `operations.operation_locks` row per held domain. Domains are acquired
 * all at once, in one global order (UTF-8 byte order of the key), so two
 * workers never wait on each other in a cycle; a conflict leaves nothing
 * behind (savepoint) and reports the holder. Locks are released only when
 * the operation finishes (in the same transaction as its last transition);
 * the database refuses to delete a live operation's lock, so there is no
 * force-release shortcut.
 */
const DOMAIN =
  /^(?:target:tgt_[0-7][0-9A-HJKMNP-TV-Z]{25}:(?:schema|maintenance)|cluster:cls_[0-7][0-9A-HJKMNP-TV-Z]{25}:(?:config|backup)|node:nod_[0-7][0-9A-HJKMNP-TV-Z]{25}:packages)$/

export function isDomainKey(value: string): boolean {
  return DOMAIN.test(value)
}

/**
 * The domains actually taken: `target:<id>:maintenance` conflicts with
 * everything on the target, so it also takes the target's schema domain.
 * Cross-object conflicts (a cluster restart and its placed targets, packages
 * and the cluster config of a node) are listed by the kind itself.
 */
export function expandDomains(domains: readonly string[]): string[] {
  const out = new Set<string>()
  for (const d of domains) {
    if (!isDomainKey(d)) {
      throw new OperationError('VALIDATION_FAILED')
    }
    out.add(d)
    if (d.endsWith(':maintenance')) {
      out.add(`${d.slice(0, -':maintenance'.length)}:schema`)
    }
  }
  return [...out].sort(compareUtf8)
}

export type LockResult =
  | { readonly acquired: true; readonly domains: readonly string[] }
  | {
      readonly acquired: false
      readonly domain: string
      readonly blockingOperationId: string
    }

export async function acquireLocks(
  tx: Tx,
  operationId: string,
  domains: readonly string[],
): Promise<LockResult> {
  const ordered = expandDomains(domains)
  try {
    return await tx.savepoint(async (sp) => {
      for (const domain of ordered) {
        const inserted = await sp.query(
          'operations.locks.acquire',
          `INSERT INTO operations.operation_locks (domain_key, operation_id) VALUES ($1, $2)
           ON CONFLICT (domain_key) DO NOTHING RETURNING domain_key`,
          [domain, operationId],
        )
        if (inserted.rows.length === 0) {
          const holder = await sp.query(
            'operations.locks.holder',
            'SELECT operation_id FROM operations.operation_locks WHERE domain_key = $1',
            [domain],
          )
          const blocking = holder.rows[0]?.text('operation_id')
          if (blocking !== operationId) {
            throw new LockConflict(domain, blocking ?? 'unknown')
          }
        }
      }
      if (ordered.length > 0) {
        await sp.query(
          'operations.event.locks_acquired',
          `INSERT INTO operations.operation_events (operation_id, kind, detail)
           VALUES ($1, 'locks_acquired', jsonb_build_object('domains', $2::text[]))`,
          [operationId, ordered],
        )
      }
      return { acquired: true, domains: ordered } as const
    })
  } catch (error) {
    if (error instanceof LockConflict) {
      await tx.query(
        'operations.event.locks_waiting',
        `INSERT INTO operations.operation_events (operation_id, kind, detail)
         VALUES ($1, 'locks_waiting', jsonb_build_object('domain', $2::text, 'blockingOperationId', $3::text))`,
        [operationId, error.domain, error.blockingOperationId],
      )
      return {
        acquired: false,
        domain: error.domain,
        blockingOperationId: error.blockingOperationId,
      }
    }
    if (error instanceof ControlStoreError && error.code === 'control_store_permission_denied') {
      throw new OperationError('operation_state_changed', { cause: error })
    }
    throw error
  }
}

class LockConflict extends Error {
  readonly domain: string
  readonly blockingOperationId: string
  constructor(domain: string, blockingOperationId: string) {
    super('exclusivity domain held by another operation')
    this.domain = domain
    this.blockingOperationId = blockingOperationId
  }
}

export async function heldLocks(q: Queryable, operationId: string): Promise<readonly string[]> {
  const { rows } = await q.query(
    'operations.locks.held',
    'SELECT domain_key FROM operations.operation_locks WHERE operation_id = $1 ORDER BY domain_key',
    [operationId],
  )
  return rows.map((r) => r.text('domain_key'))
}
