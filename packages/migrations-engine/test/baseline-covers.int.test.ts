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
 * ADR-0040 (OD-72 (a)) on real PostgreSQL: a production target received the effect of a stream
 * bundle outside ExponetDB (its staging got the bundle through ExponetDB). Its baseline covers
 * that bundle: the plan refuses an uncovered dependency and a bundle without staging evidence,
 * the baseline writes the covered row and verifies its verify.sql, and the next plan on
 * production holds only the bundle production really lacks.
 */
const BASELINE = 'acme-covered'

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
    let scratch: Target
    let reportId = ''
    const ids = { items: '', tags: '', unproven: '' }

    beforeAll(async () => {
      w = await migrationWorld(`exdb_it_cv${server.major}`, server)
      staging = await w.registerTarget('staging', 'nonprod')
      production = await w.registerTarget('production', 'prod', 'staging')
      scratch = await w.registerTarget('scratch', 'nonprod')
      ids.items = w.ulid()
      ids.tags = w.ulid()
      ids.unproven = w.ulid()
      // Staging gets both bundles through ExponetDB.
      const items = w.bundle({ id: ids.items, name: 'items', up: ITEMS, verify: ITEMS_VERIFY })
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
      const p = await w.h.serve.transaction('test.cv.analyze', (tx) =>
        planImportAnalysis(tx, w.ctx, w.a, production.record.targetId, {
          scratchTarget: scratch.record.targetId,
          baseline: BASELINE,
          files: [{ name: '0001_items.sql', text: ITEMS }],
        }),
      )
      reportId = String((p.body['content'] as { reportId: string }).reportId)
      w.setRules('registry-only')
      expect(await w.apply(p)).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
      w.setRules('all')
      const report = await w.h.worker.transaction('test.cv.report', (tx) =>
        importReportView(tx, production.record.targetId, reportId),
      )
      expect(report.items.map((i) => [i.name, i.state])).toEqual([
        ['0001_items', 'unrecorded_present'],
      ])
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
        details: { migrationId: `baseline:${BASELINE}`, missing: [stranger] },
      })
    })

    it('refuses a cover without staging evidence on production', async () => {
      await expect(baselinePlan([ids.items, ids.tags, ids.unproven])).rejects.toMatchObject({
        code: 'STAGING_EVIDENCE_MISSING',
      })
    })

    it('baselines with the covered bundle as an applied row and verifies its verify.sql', async () => {
      const p = await baselinePlan([ids.items])
      expect(p.body['analysis']).toMatchObject({ imported: 1, covered: 1 })
      w.setRules('registry-only')
      const op = await w.apply(p)
      w.setRules('all')
      expect(op).toMatchObject({
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
      expect(rows).toEqual([
        {
          migration_id: 'legacy:0001_items',
          origin: 'legacy_import',
          checksum_provenance: expect.any(String),
          deps: '{}',
          covered: null,
        },
        {
          migration_id: ids.items,
          origin: 'legacy_import',
          checksum_provenance: 'legacy_applied_statements',
          deps: '{}',
          covered: 'true',
        },
        {
          migration_id: `baseline:${BASELINE}`,
          origin: 'baseline',
          checksum_provenance: 'computed_at_apply',
          deps: '{}',
          covered: null,
        },
      ])
      const detail = await migrationDetail(
        {
          store: w.h.worker,
          connector: w.h.workerConnector,
          installationId: w.h.db.installationId,
        },
        production.record,
        `baseline:${BASELINE}`,
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
      const items = w.bundle({ id: ids.items, name: 'items', up: ITEMS, verify: ITEMS_VERIFY })
      const tags = w.bundle({ id: ids.tags, name: 'tags', up: TAGS, dependsOn: [ids.items] })
      const p = await w.plan(production, { bundles: [items, tags] })
      const planned = (p.body['content'] as { items: { migrationId: string }[] }).items
      expect(planned.map((i) => i.migrationId)).toEqual([ids.tags])
      w.setRules('registry-only')
      const op = await w.apply(p)
      w.setRules('all')
      expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
      const tables = await rowsOf(
        server,
        production.database,
        `SELECT pg_catalog.to_regclass('public.cv_tags')::text AS tags`,
      )
      expect(tables).toEqual([{ tags: 'cv_tags' }])
    })
  },
)
