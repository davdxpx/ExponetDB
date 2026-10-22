import { scratchResetSql } from '@exponetdb/migrations/format'
import { stampTarget, takeSchemaLock } from '@exponetdb/postgres'
import { dropDatabase, matrix, runAsSuperuser, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { open, prepareDatabase } from '../../postgres/test/targets.ts'

/**
 * The in-place reset of a scratch target (legacy-import.md §2.5) with the
 * extensions of a Supabase-origin project in its managed schema, on
 * PostgreSQL 16, 17 and 18 (follow-up 2, F2): `vector` (access methods and
 * casts without a schema of their own) and `pg_trgm` in `public` are
 * dropped with the schema and re-created in their versions; nothing else
 * refuses the reset.
 */
const INSTALLATION = 'ins_01M5K000000000000000000001'
const TARGET = 'tgt_01M5K000000000000000000002'

describe.each(matrix().map((s) => [s.major, s] as const))(
  'the scratch reset with vector and pg_trgm in public on PostgreSQL %i',
  (_major, server) => {
    let database = ''

    beforeAll(async () => {
      database = await prepareDatabase(server, `reset_${server.major}`)
      const migrator = await open(server, database, 'migrator')
      try {
        const release = await takeSchemaLock(migrator, TARGET)
        const stamped = await stampTarget(
          migrator,
          {
            databaseOid: migrator.facts.databaseOid,
            installationId: INSTALLATION,
            targetId: TARGET,
            targetPath: 'acme/platform/scratch',
            tier: 'nonprod',
            generation: 1,
            operationId: 'op_01M5K000000000000000000003',
            projectId: 'prj_01M5K000000000000000000004',
          },
          migrator.facts.systemIdentifier,
        )
        await release()
        expect(stamped.status).toBe('stamped')
      } finally {
        await migrator.close()
      }
      await runAsSuperuser(server, database, [
        'CREATE EXTENSION vector SCHEMA public',
        'CREATE EXTENSION pg_trgm SCHEMA public',
        // What a replay left behind.
        'CREATE TABLE public.acme_documents (id bigint PRIMARY KEY, body text, embedding public.vector(3))',
        'CREATE INDEX acme_documents_embedding ON public.acme_documents USING hnsw (embedding public.vector_l2_ops)',
        'CREATE INDEX acme_documents_body ON public.acme_documents USING gin (body public.gin_trgm_ops)',
      ])
    }, 120_000)

    afterAll(async () => {
      if (database !== '') await dropDatabase(server, database)
    })

    const extensions = () =>
      withSuperuser(server, database, (c) =>
        c.query(
          `SELECT x.extname AS name, n.nspname AS schema, x.extversion AS version
             FROM pg_catalog.pg_extension x JOIN pg_catalog.pg_namespace n ON n.oid = x.extnamespace
            WHERE x.extname IN ('vector', 'pg_trgm') ORDER BY 1`,
        ),
      )

    it('drops what the replay left and re-creates the extensions in their versions', async () => {
      const before = (await extensions()).rows
      expect(before.map((r) => r.name)).toEqual(['pg_trgm', 'vector'])
      await runAsSuperuser(server, database, [
        scratchResetSql({
          installationId: INSTALLATION,
          targetId: TARGET,
          targetPath: 'acme/platform/scratch',
          generation: 1,
          includeSchemas: ['public'],
        }),
      ])
      expect((await extensions()).rows).toEqual(before)
      const left = await withSuperuser(server, database, (c) =>
        c.query(
          `SELECT pg_catalog.to_regclass('public.acme_documents') IS NULL AS dropped,
                  (SELECT count(*)::int FROM pg_catalog.pg_am WHERE amname = 'hnsw') AS hnsw,
                  (SELECT target_id FROM exponetdb.target_identity) AS marker`,
        ),
      )
      expect(left.rows[0]).toEqual({ dropped: true, hnsw: 1, marker: TARGET })
    })
  },
)
