import { type CatalogReader, TargetError, type TargetRow } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import { legacyLedgerDigest } from '../src/legacy-ledger.ts'

/** A reader whose ledger table exists and whose names read fails with `failure`. */
function reader(failure: unknown): CatalogReader {
  return {
    facts: {} as CatalogReader['facts'],
    async query(statement) {
      const text = statement.text
      if (text.includes('to_regclass')) return [{ bool: () => true } as unknown as TargetRow]
      if (text.includes('supabase_migrations.schema_migrations')) throw failure
      return []
    },
    async readCursor() {
      return { rows: [], truncated: false }
    },
  }
}

describe('the names-only digest of an observed target legacy ledger (W10-4)', () => {
  it('names a refused read unreadable', async () => {
    const denied = new TargetError('PERMISSION_DENIED', 'insufficient_privilege', {
      sqlstate: '42501',
    })
    expect(await legacyLedgerDigest(reader(denied))).toEqual({
      source: 'supabase',
      status: 'unreadable',
    })
  })

  it('raises an error that is not a refused read again instead of binding it (review L1)', async () => {
    const bug = new Error('a row the engine cannot decode')
    await expect(legacyLedgerDigest(reader(bug))).rejects.toBe(bug)
    const timeout = new TargetError('QUERY_TIMEOUT', 'statement_timeout')
    await expect(legacyLedgerDigest(reader(timeout))).rejects.toBe(timeout)
  })
})
