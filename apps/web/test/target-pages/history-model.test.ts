import type { LedgerEntry, MigrationStatus } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  historyRows,
  ledgerCounts,
  migrationsSearch,
  verificationGroup,
  viewOf,
} from '../../src/features/migrations/history-model.ts'
import { ledgerEntry, ledgerStatus } from './support.tsx'

const entry = (n: number, over: Record<string, unknown> = {}) =>
  ledgerEntry(n, over) as unknown as LedgerEntry

describe('the history of the migration centre', () => {
  it('groups every verification that did not pass as failed, and a superseded row apart', () => {
    for (const status of ['failed', 'partial', 'error', 'something_new']) {
      expect(
        verificationGroup(
          entry(1, { verification: { status, verifiedAt: null, verifyDigest: null } }),
        ),
      ).toBe('failed')
    }
    expect(
      verificationGroup(
        entry(1, {
          verification: {
            status: 'passed',
            verifiedAt: null,
            verifyDigest: null,
            superseded: true,
          },
        }),
      ),
    ).toBe('superseded')
  })

  it('filters by text, origin and verification and sorts newest first by default', () => {
    const rows = [
      entry(1),
      entry(2, { origin: 'legacy_import', name: 'legacy_users' }),
      entry(3, { verification: { status: 'failed', verifiedAt: null, verifyDigest: null } }),
    ]
    // entry(1) is applied most recently (1 minute ago).
    expect(historyRows(rows, {}).map((r) => r.name)).toEqual([
      'add_orders_1',
      'legacy_users',
      'add_orders_3',
    ])
    expect(historyRows(rows, { sort: 'oldest' }).map((r) => r.name)[0]).toBe('add_orders_3')
    expect(historyRows(rows, { q: 'LEGACY' }).map((r) => r.name)).toEqual(['legacy_users'])
    expect(historyRows(rows, { origin: 'legacy_import' })).toHaveLength(1)
    expect(historyRows(rows, { verification: 'failed' }).map((r) => r.name)).toEqual([
      'add_orders_3',
    ])
  })

  it('counts the ledger, the imported rows and the bundles not applied', () => {
    const status = ledgerStatus({
      applied: [entry(1), entry(2, { origin: 'legacy_import' }), entry(3, { origin: 'baseline' })],
    }) as unknown as MigrationStatus
    expect(ledgerCounts(status)).toMatchObject({
      applied: 3,
      verified: 3,
      imported: 1,
      baselines: 1,
      notApplied: status.pending.length,
    })
  })

  it('opens the legacy import for a report link and the history otherwise', () => {
    expect(viewOf(migrationsSearch({ report: 'imr_01M4S90000000000000000000A' }))).toBe('import')
    expect(viewOf(migrationsSearch({}))).toBe('history')
    expect(
      viewOf(migrationsSearch({ view: 'timeline', report: 'imr_01M4S90000000000000000000A' })),
    ).toBe('timeline')
  })
})
