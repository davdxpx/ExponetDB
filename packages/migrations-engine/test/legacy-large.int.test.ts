import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scratchCheck } from '../src/index.ts'
import { type LargeWorld, largeWorld } from './large-world.ts'

/**
 * A legacy history of the size of the first real import (follow-up 2, F4:
 * 556 files, about 2.7 MB): 600 files, 3 MB, Supabase-origin shapes
 * (policies calling the identity service, PL/pgSQL triggers, guarded role
 * grants, comment-only files, large function libraries), analyzed on
 * PostgreSQL 17 end to end: checked with its files, planned as serve plans
 * it, replayed as the worker replays it, classified. The memory each step
 * needs is measured in a 512 MiB container by
 * `scripts/measure-analyze-memory.ts` (deployment.md §2a); a test process
 * holds too much else to measure it.
 */
let w: LargeWorld

beforeAll(async () => {
  w = await largeWorld()
}, 600_000)

afterAll(async () => {
  await w?.close()
})

describe('a legacy history of 600 files and 3 MB (PostgreSQL 17)', () => {
  it('is checked, planned, replayed and classified', async () => {
    const check = await scratchCheck(
      w.h.worker,
      { connector: w.h.workerConnector, installationId: w.h.db.installationId },
      w.imported,
      w.scratch.targetId,
      'owner',
      w.history,
    )
    expect(check.ready, JSON.stringify(check.checks)).toBe(true)
    const p = await w.plan()
    expect(p.decision).toBe('allow')
    const replay = (p.body['analysis'] as { replay: { counts: Record<string, number> } }).replay
    // Every 25th file grants a role behind a guard on pg_roles, elided (F1); the 200th and
    // the 400th are comment-only files.
    expect(replay.counts).toMatchObject({ elided: 21, mixedDoBlocks: 0, noStatements: 14 })
    expect(await w.apply(p)).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
    const r = await w.report(p)
    expect([r.state, r.incompleteReason ?? null]).toEqual(['open', null])
    expect(r.items.filter((i) => i.legacyId.startsWith('legacy:'))).toHaveLength(600)
    expect(r.items.filter((i) => i.state.endsWith('_missing'))).toEqual([])
  }, 900_000)
})
