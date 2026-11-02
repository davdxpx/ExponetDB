import { serverFor, superuserClient } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationWorld, type World } from './world.ts'

/**
 * VC-030, the wiring (the review of group F): the planner reads the target's validated
 * `CHECK (column IS NOT NULL)` constraints and hands them to the lint, so the documented recipe
 * passes; without one, `unsafe_not_null` is raised on a table over the size threshold.
 */
const pg = serverFor(17)
let w: World

beforeAll(async () => {
  w = await migrationWorld('exdb_it_mig_pnn', pg)
}, 240_000)

afterAll(async () => {
  await w?.close()
})

describe('SET NOT NULL against the target catalog (VC-030)', () => {
  const lintRules = (plan: { body: Record<string, unknown> }) =>
    (
      plan.body['analysis'] as { perMigration: { lint: { rule: string }[] }[] }
    ).perMigration.flatMap((m) => m.lint.map((l) => l.rule))

  it('raises unsafe_not_null without a validated CHECK and not with one', async () => {
    const t = await w.registerTarget('pnn-a', 'nonprod')
    const base = w.ulid()
    expect(
      await w.apply(
        await w.plan(t, {
          bundles: [
            w.bundle({
              id: base,
              name: 'base',
              up: "CREATE TABLE public.pnn (id int, note text);\nINSERT INTO public.pnn VALUES (1, 'a'), (2, 'b');\n",
            }),
          ],
        }),
      ),
    ).toMatchObject({ state: 'succeeded' })
    const setNotNull = () =>
      w.plan(t, {
        bundles: [
          w.bundle({
            name: 'not-null',
            up: 'ALTER TABLE public.pnn ALTER COLUMN note SET NOT NULL;\n',
            declared: 'potentially_breaking',
            dependsOn: [base],
          }),
        ],
        // Any table of a few pages is "large" here.
        lint: { sizeThreshold: { bytes: 1000, rows: 1 } },
      })
    expect(lintRules(await setNotNull())).toContain('unsafe_not_null')
    const c = await superuserClient(pg, t.database)
    try {
      await c.query(
        'ALTER TABLE public.pnn ADD CONSTRAINT pnn_note_nn CHECK (note IS NOT NULL) NOT VALID',
      )
      // Not validated yet: no proof.
      expect(lintRules(await setNotNull())).toContain('unsafe_not_null')
      await c.query('ALTER TABLE public.pnn VALIDATE CONSTRAINT pnn_note_nn')
    } finally {
      await c.end()
    }
    expect(lintRules(await setNotNull())).not.toContain('unsafe_not_null')
  })
})
