import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import type { Clock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPlan, PLAN_LIFETIME_MS } from '../src/index.ts'
import { decision, human, stores } from './support.ts'

/**
 * VC-040: a plan's `created_at` and `expires_at` came from the creating process's clock, and the
 * database CHECK (`expires_at <= created_at + 2 hours`) is relative to that same wrong
 * `created_at`, while accept and expiry judge with the database clock. A serve a day ahead gave a
 * 15 minute critical plan a day of life in database time; behind, a plan expired early. The plan's
 * times are database time.
 */
let db: MigratedTestDatabase
let as: ReturnType<typeof stores>

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_plan_clock')
  as = stores(db)
})

afterAll(async () => {
  await db?.drop()
})

const skewed = (offsetMs: number): Clock => ({ nowMs: () => Date.now() + offsetMs })

async function planWith(clock: Clock) {
  const plan = await as('exdb_serve').transaction('test.plan.skewed', async (tx) =>
    createPlan(
      tx,
      {
        kind: 'synthetic.apply',
        kindVersion: 1,
        actionClass: 'critical',
        actor: human,
        subject: { tier: 'nonprod' },
        content: { domains: [], note: 'clock' },
        policy: await decision(),
      },
      { clock },
    ),
  )
  const { rows } = await as('exdb_serve').query(
    'test.plan.times',
    `SELECT extract(epoch FROM (expires_at - clock_timestamp())) * 1000 AS left_ms,
            extract(epoch FROM (clock_timestamp() - created_at)) * 1000 AS age_ms
       FROM operations.plans WHERE plan_id = $1`,
    [plan.planId],
  )
  return { left: Number(rows[0]?.text('left_ms')), age: Number(rows[0]?.text('age_ms')) }
}

describe('the times of a new plan (VC-040)', () => {
  const limit = PLAN_LIFETIME_MS.critical.default

  it('are the lifetime of its class from now, in database time', async () => {
    const { left, age } = await planWith(skewed(0))
    expect(left).toBeGreaterThan(limit - 5000)
    expect(left).toBeLessThanOrEqual(limit)
    expect(Math.abs(age)).toBeLessThan(5000)
  })

  it('do not stretch when the creating process is a day ahead', async () => {
    const { left } = await planWith(skewed(24 * 3600_000))
    expect(left).toBeLessThanOrEqual(limit)
    expect(left).toBeGreaterThan(limit - 5000)
  })

  it('do not shrink when the creating process is an hour behind', async () => {
    const { left } = await planWith(skewed(-3600_000))
    expect(left).toBeGreaterThan(limit - 5000)
  })
})
