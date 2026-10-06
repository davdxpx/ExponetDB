import {
  CONSUMER_SIZED,
  consumerSizedStatements,
  dropDatabase,
  type Fixture,
  matrix,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { takeSnapshot } from '../src/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * The fingerprint budget (schema-fingerprints.md §7, order §144): a full
 * snapshot of a consumer-sized schema (400 tables, 380 policies, 1,400
 * indexes, 110 functions) stays under 2 seconds. Measured, not assumed:
 * two warm-up runs, then 15 runs each on a fresh observer session; the
 * median must be within the budget, and median, p95 and maximum are
 * printed for the G4 gate record.
 */
const SIZED: Fixture = { name: 'consumer_sized', cluster: [], database: consumerSizedStatements() }
const BUDGET_MS = 2000
const RUNS = 15

describe.each(matrix().map((s) => [s.major, s] as const))(
  'fingerprint budget on PostgreSQL %i',
  (_major, server) => {
    let database = ''

    beforeAll(async () => {
      database = await prepareDatabase(server, `budget_${server.major}`, SIZED)
    }, 300_000)

    afterAll(async () => {
      await dropDatabase(server, database)
    })

    async function once() {
      const s = await open(server, database, 'observer')
      try {
        return await takeSnapshot(s)
      } finally {
        await s.close()
      }
    }

    it('snapshots a consumer-sized schema within 2 seconds (median of 15 runs)', async () => {
      const first = await once()
      expect(first.complete).toBe(true)
      const count = (cls: string) => first.document.entries.filter((e) => e.class === cls).length
      expect(count('table')).toBe(CONSUMER_SIZED.tables)
      expect(count('policy')).toBe(CONSUMER_SIZED.rowSecurityTables * 2)
      expect(count('index')).toBe(CONSUMER_SIZED.indexes)
      expect(count('function')).toBe(CONSUMER_SIZED.functions)
      await once()
      const durations: number[] = []
      for (let run = 0; run < RUNS; run++) {
        const snap = await once()
        expect(snap.fingerprint).toBe(first.fingerprint)
        durations.push(snap.stats.durationMs)
      }
      durations.sort((a, b) => a - b)
      const at = (q: number) =>
        durations[Math.min(durations.length - 1, Math.ceil(q * durations.length) - 1)] ?? 0
      const median = at(0.5)
      console.info(
        `fingerprint budget PG${server.major}: ${first.document.entries.length} entries, ${first.stats.queries} queries; ` +
          `median ${median} ms, p95 ${at(0.95)} ms, max ${durations.at(-1)} ms over ${RUNS} runs`,
      )
      expect(median).toBeLessThan(BUDGET_MS)
    }, 300_000)
  },
)
