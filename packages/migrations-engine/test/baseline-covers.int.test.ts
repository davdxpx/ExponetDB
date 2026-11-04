import { matrix, runAsSuperuser, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  importReportView,
  migrationDetail,
  migrationStatus,
  planBaseline,
  planImportAnalysis,
} from '../src/index.ts'
import { migrationWorld, OWNER, type Target, type World } from './world.ts'

/**
 * ADR-0040 (OD-72 (a)) on real PostgreSQL: staging and production share a history and a
 * baseline. Staging then got two stream bundles through ExponetDB; production received the
 * first one's statements outside ExponetDB, as a legacy file, before it was imported. Its
 * baseline covers that bundle: the plan refuses an uncovered dependency, an unknown id, a root
 * and a bundle without staging evidence; the baseline writes the covered row and verifies its
 * verify.sql; the next plan on production holds only the bundle production really lacks.
 */
const BASELINE = 'acme-covered'
const REF = `baseline:${BASELINE}`

const BASE = 'CREATE TABLE public.cv_base (id bigint PRIMARY KEY);\n'
const ITEMS = 'CREATE TABLE public.cv_items (id bigint PRIMARY KEY, name text NOT NULL);\n'
const ITEMS_VERIFY = `-- check: the items table is readable
SELECT count(*) >= 0 AS ok FROM public.cv_items;
`
const TAGS = 'CREATE TABLE public.cv_tags (id bigint PRIMARY KEY);\n'

/** Rows of one superuser query on a target database (the test's independent read). */
const rowsOf = (server: Parameters<typeof withSuperuser>[0], database: string, text: string) =>
  withSuperuser(server, database, async (c) => (await c.query(text)).rows)

describe.each(matrix().map((s) => [s.major, s] as const))(
  'a baseline that covers bundles on PostgreSQL %i',
  (_major, server) => {
    let w: World
    let staging: Target
    let production: Target
    let reportId = ''
    const ids = { items: '', tags: '', unproven: '' }

    /** Analyzes a target's history on its own empty scratch target; returns the report id. */
    const analyze = async (target: Target, scratch: Target, files: readonly string[]) => {
      const p = await w.h.serve.transaction('test.cv.analyze', (tx) =>
        planImportAnalysis(tx, w.ctx, w.a, target.record.targetId, {
          scratchTarget: scratch.record.targetId,
          baseline: BASELINE,
          files: files.map((text, i) => ({ name: `000${i}_history.sql`, text })),
        }),
      )
      expect(await w.apply(p)).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
      const id = String((p.body['content'] as { reportId: string }).reportId)
      const report = await w.h.worker.transaction('test.cv.report', (tx) =>
        importReportView(tx, target.record.targetId, id),
      )
      expect(report.items.every((i) => i.state === 'unrecorded_present')).toBe(true)
      return id
    }

    beforeAll(async () => {
      w = await migrationWorld(`exdb_it_cv${server.major}`, server)
      // Approvals are policy, not this suite's subject: production's are covered elsewhere.
      w.setRules('registry-only')
      staging = await w.registerTarget('staging', 'nonprod')
      production = await w.registerTarget('production', 'prod', 'staging')
      const stagingScratch = await w.registerTarget('scratch', 'nonprod')
      const productionScratch = await w.registerTarget('production-scratch', 'nonprod')
      for (const t of [staging, production]) {
        await runAsSuperuser(server, t.database, [
          BASE,
          `ALTER TABLE public.cv_base OWNER TO ${OWNER}`,
        ])
      }
      const stagingReport = await analyze(staging, stagingScratch, [BASE])
      expect(
        await w.apply(
          await w.h.serve.transaction('test.cv.baseline', (tx) =>
            planBaseline(tx, w.ctx, w.a, staging.record.targetId, stagingReport),
          ),
        ),
      ).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
      ids.items = w.ulid()
      ids.tags = w.ulid()
      ids.unproven = w.ulid()
      // Staging gets both bundles through ExponetDB.
      const items = w.bundle({
        id: ids.items,
        name: 'items',
        up: ITEMS,
        verify: ITEMS_VERIFY,
        dependsOn: [REF],
      })
      const tags = w.bundle({ id: ids.tags, name: 'tags', up: TAGS, dependsOn: [ids.items] })
      expect(await w.apply(await w.plan(staging, { bundles: [items, tags] }))).toMatchObject({
        state: 'succeeded',
        verificationOutcome: 'passed',
      })
      // A bundle the store knows (planned, never applied): no evidence anywhere.
      await w.plan(staging, {
        bundles: [
          w.bundle({
            id: ids.unproven,
            name: 'unproven',
            up: 'CREATE TABLE public.cv_unproven (id int);\n',
            dependsOn: [ids.tags],
          }),
        ],
      })
      // Production got the first bundle's statements outside ExponetDB, as a legacy file.
      await runAsSuperuser(server, production.database, [
        ITEMS,
        `ALTER TABLE public.cv_items OWNER TO ${OWNER}`,
      ])
      reportId = await analyze(production, productionScratch, [BASE, ITEMS])
    }, 300_000)

    afterAll(async () => {
      await w?.close()
    })

    const baselinePlan = (covers: readonly string[]) =>
      w.h.serve.transaction('test.cv.baseline', (tx) =>
        planBaseline(tx, w.ctx, w.a, production.record.targetId, reportId, covers),
      )

    it('refuses a cover whose dependency is not covered', async () => {
      await expect(baselinePlan([ids.tags])).rejects.toMatchObject({
        code: 'MIGRATION_DEPENDENCY_UNKNOWN',
        details: { migrationId: ids.tags, missing: [ids.items] },
      })
    })

    it('refuses a cover of an id the stream does not hold', async () => {
      const stranger = w.ulid()
      await expect(baselinePlan([stranger])).rejects.toMatchObject({
        code: 'MIGRATION_DEPENDENCY_UNKNOWN',
        details: { migrationId: REF, missing: [stranger] },
      })
    })

    it('refuses a cover without staging evidence on production', async () => {
      await expect(baselinePlan([ids.items, ids.tags, ids.unproven])).rejects.toMatchObject({
        code: 'STAGING_EVIDENCE_MISSING',
      })
    })

    it('baselines with the covered bundle as an applied row and verifies its verify.sql', async () => {
      const p = await baselinePlan([ids.items])
      expect(p.body['analysis']).toMatchObject({ imported: 2, covered: 1 })
      expect(await w.apply(p)).toMatchObject({
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
      })
      const rows = await rowsOf(
        server,
        production.database,
        `SELECT migration_id, origin, checksum_provenance, dependencies::text AS deps,
                source->>'covered' AS covered
           FROM exponetdb.schema_migrations ORDER BY applied_seq`,
      )
      expect(rows.map((r) => [r.migration_id, r.origin, r.covered])).toEqual([
        ['legacy:0000_history', 'legacy_import', null],
        ['legacy:0001_history', 'legacy_import', null],
        [ids.items, 'legacy_import', 'true'],
        [REF, 'baseline', '1'],
      ])
      expect(rows[2]).toMatchObject({
        checksum_provenance: 'legacy_applied_statements',
        deps: `{${REF}}`,
      })
      const detail = await migrationDetail(
        {
          store: w.h.worker,
          connector: w.h.workerConnector,
          installationId: w.h.db.installationId,
        },
        production.record,
        REF,
      )
      expect(detail.verifications.at(-1)).toMatchObject({
        status: 'passed',
        runtime: { status: 'passed', checks: 1, failed: 0 },
      })
    })

    it('plans on production only what production lacks, and counts the covered bundle as applied', async () => {
      const status = await migrationStatus(
        {
          store: w.h.worker,
          connector: w.h.workerConnector,
          installationId: w.h.db.installationId,
        },
        production.record,
      )
      expect(status.pending.map((p) => p.migrationId)).toEqual([ids.tags, ids.unproven])
      const items = w.bundle({
        id: ids.items,
        name: 'items',
        up: ITEMS,
        verify: ITEMS_VERIFY,
        dependsOn: [REF],
      })
      const tags = w.bundle({ id: ids.tags, name: 'tags', up: TAGS, dependsOn: [ids.items] })
      const p = await w.plan(production, { bundles: [items, tags] })
      const planned = (p.body['content'] as { migrations: { migrationId: string }[] }).migrations
      expect(planned.map((i) => i.migrationId)).toEqual([ids.tags])
      expect(await w.apply(p)).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
      const tables = await rowsOf(
        server,
        production.database,
        `SELECT pg_catalog.to_regclass('public.cv_tags')::text AS tags`,
      )
      expect(tables).toEqual([{ tags: 'cv_tags' }])
    })
  },
)
