import { matrix, runAsSuperuser } from '@exponetdb/testkit'
import { describe, expect, it } from 'vitest'
import { provenNotNullColumns } from '../src/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * VC-030: the documented NOT NULL recipe (a CHECK added NOT VALID, validated, then SET NOT NULL)
 * could not pass the planner because the lint never learned of the validated CHECK. The planner
 * reads the target's validated `CHECK (column IS NOT NULL)` constraints from the catalog.
 */
describe.each(matrix().map((s) => [s.major, s] as const))(
  'validated CHECK (column IS NOT NULL) constraints on PostgreSQL %i',
  (_m, server) => {
    it('lists the validated ones on one column and no other check', async () => {
      const db = await prepareDatabase(server, `pnn_${server.major}`)
      await runAsSuperuser(server, db, [
        'CREATE TABLE public.leads (id bigint, note text, "Title" text, other text, pair_a int, pair_b int)',
        'ALTER TABLE public.leads ADD CONSTRAINT leads_note_nn CHECK (note IS NOT NULL)',
        'ALTER TABLE public.leads ADD CONSTRAINT leads_title_nn CHECK ("Title" IS NOT NULL)',
        'ALTER TABLE public.leads ADD CONSTRAINT leads_other_nn CHECK (other IS NOT NULL) NOT VALID',
        'ALTER TABLE public.leads ADD CONSTRAINT leads_id_pos CHECK (id > 0)',
        'ALTER TABLE public.leads ADD CONSTRAINT leads_pair CHECK (pair_a IS NOT NULL AND pair_b IS NOT NULL)',
      ])
      const session = await open(server, db, 'observer')
      try {
        const proven = await provenNotNullColumns(session)
        expect([...proven].sort()).toEqual(['public.leads.Title', 'public.leads.note'])
      } finally {
        await session.close()
      }
    })
  },
)
