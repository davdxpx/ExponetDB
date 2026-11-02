import { readLedgerRows } from '@exponetdb/postgres'
import { serverFor } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationWorld, type World } from './world.ts'

/**
 * VC-069: a plan that stops part-way left the drift baseline behind. The expected schema advanced
 * only when the whole operation passed, so the next plan's start (the live fingerprint) differed
 * from the stored baseline, and every later verified bundle read as drift. The verified prefix of
 * an operation is now the target's expected schema.
 */
const pg17 = serverFor(17)
let w: World
const recorded: { fingerprint: string; preFingerprint: string | undefined }[] = []

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_prefix', pg17, {
    record: async (input) => {
      recorded.push({ fingerprint: input.fingerprint, preFingerprint: input.preFingerprint })
    },
  })
}, 240_000)

afterAll(async () => {
  await w?.close()
})

describe('the expected schema after a plan that stops part-way (VC-069)', () => {
  it('is the schema of the last verified bundle, from the plan start, and not a schema a failed bundle changed', async () => {
    const t = await w.registerTarget('bp-a', 'nonprod')
    const b1 = w.bundle({ name: 'one', up: 'CREATE TABLE public.one (id int);\n' })
    const b2 = w.bundle({
      name: 'two',
      up: 'CREATE TABLE public.two (id int);\n',
      dependsOn: [idOf(b1)],
    })
    // Fails when it runs: the table exists already.
    const b3 = w.bundle({
      name: 'three',
      up: 'CREATE TABLE public.one (id int);\n',
      dependsOn: [idOf(b2)],
    })
    const plan = await w.plan(t, { bundles: [b1, b2, b3] })
    const start = (plan.body['content'] as { expectedState: { schemaFingerprint: string | null } })
      .expectedState.schemaFingerprint
    recorded.length = 0
    const op = await w.apply(plan)
    expect(op.state).not.toBe('succeeded')
    const live = await w.h.workerConnector.forTarget(t.record, 'observer', 'test')
    let afterSecond: string | null | undefined
    try {
      const rows = await live.session.readOnly((tx) => readLedgerRows(tx))
      afterSecond = rows.find((r) => r.migrationId === idOf(b2))?.fingerprintAfter
      expect(rows.map((r) => r.migrationId)).toEqual([idOf(b1), idOf(b2)])
    } finally {
      await live.session.close()
    }
    expect(recorded).toEqual([{ fingerprint: afterSecond, preFingerprint: start ?? undefined }])
  })
})

function idOf(b: { directory: string }): string {
  return b.directory.split('_')[0] ?? ''
}
