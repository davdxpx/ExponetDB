import {
  dropDatabase,
  type Fixture,
  matrix,
  reosaShapedEventTriggerStatements,
  reosaShapedRoleStatements,
  reosaShapedStatements,
  runAsSuperuser,
} from '@exponetdb/testkit'
import { describe, expect, it } from 'vitest'
import {
  isEmptyLedger,
  LEDGER_TABLES,
  ledgerShape,
  readMarker,
  type Stamp,
  StampRefused,
  sql,
  stampTarget,
  TargetError,
  type TargetSession,
  takeSchemaLock,
  takeSnapshot,
} from '../src/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * G4 item 1 (security), target side: the identity marker and the empty
 * ledger; registration refuses a Control Store, another installation's
 * marker and another target's marker; it is idempotent, safe under
 * concurrency, survives an event trigger that enables row security on new
 * tables, and its result is read back on a fresh connection.
 */
const INSTALLATION = 'ins_01M4A000000000000000000001'
const OTHER_INSTALLATION = 'ins_01M4A000000000000000000002'

function stamp(session: TargetSession, targetId: string, extra: Partial<Stamp> = {}): Stamp {
  return {
    databaseOid: session.facts.databaseOid,
    installationId: INSTALLATION,
    targetId,
    targetPath: 'acme/app/staging',
    tier: 'nonprod',
    generation: 1,
    operationId: 'op_01M4A000000000000000000003',
    projectId: 'prj_01M4A000000000000000000004',
    ...extra,
  }
}

async function refusal(promise: Promise<unknown>): Promise<StampRefused | TargetError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof StampRefused || error instanceof TargetError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

const SHAPED: Fixture = {
  name: 'shaped_with_trigger',
  cluster: reosaShapedRoleStatements(),
  database: [...reosaShapedStatements(), ...reosaShapedEventTriggerStatements()],
}

describe.each(matrix().map((s) => [s.major, s] as const))(
  'registration on PostgreSQL %i',
  (_m, server) => {
    const target = 'tgt_01M4A000000000000000000010'

    it('stamps the marker and an empty ledger, and reads both back on a fresh connection', async () => {
      const db = await prepareDatabase(server, `reg_${server.major}`)
      try {
        const migrator = await open(server, db, 'migrator')
        const release = await takeSchemaLock(migrator, target)
        const before = await takeSnapshotOf(server, db)
        const result = await stampTarget(
          migrator,
          stamp(migrator, target),
          migrator.facts.systemIdentifier,
        )
        await release()
        await migrator.close()
        expect(result.status).toBe('stamped')
        const observer = await open(server, db, 'observer')
        try {
          const marker = await readMarker(observer)
          expect(marker).toMatchObject({
            status: 'present',
            marker: {
              installationId: INSTALLATION,
              targetId: target,
              generation: 1,
              tier: 'nonprod',
            },
          })
          const shape = await ledgerShape(observer)
          expect(shape.tables).toEqual([...LEDGER_TABLES].sort())
          expect(isEmptyLedger(shape)).toBe(true)
          // The ledger is outside every fingerprint scope.
          const after = await takeSnapshot(observer)
          expect(after.fingerprint).toBe(before)
        } finally {
          await observer.close()
        }
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('is idempotent for the same target and generation, and refuses another target or installation', async () => {
      const db = await prepareDatabase(server, `reg_idem_${server.major}`)
      try {
        const migrator = await open(server, db, 'migrator')
        try {
          const id = migrator.facts.systemIdentifier
          expect((await stampTarget(migrator, stamp(migrator, target), id)).status).toBe('stamped')
          expect((await stampTarget(migrator, stamp(migrator, target), id)).status).toBe(
            'already_stamped',
          )
          const other = await refusal(
            stampTarget(migrator, stamp(migrator, 'tgt_01M4A000000000000000000011'), id),
          )
          expect(other).toMatchObject({ reason: 'other_target' })
          const foreign = await refusal(
            stampTarget(
              migrator,
              stamp(migrator, target, { installationId: OTHER_INSTALLATION }),
              id,
            ),
          )
          expect(foreign).toMatchObject({ reason: 'foreign_installation' })
          const generation = await refusal(
            stampTarget(migrator, stamp(migrator, target, { generation: 2 }), id),
          )
          expect(generation).toMatchObject({ reason: 'generation_mismatch' })
          const cluster = await refusal(stampTarget(migrator, stamp(migrator, target), '1'))
          expect(cluster).toMatchObject({ code: 'CLUSTER_IDENTITY_MISMATCH' })
        } finally {
          await migrator.close()
        }
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('refuses a database other than the one the plan observed (oid), writing nothing', async () => {
      const db = await prepareDatabase(server, `reg_oid_${server.major}`)
      try {
        const migrator = await open(server, db, 'migrator')
        try {
          // The same name, but a re-created database has another oid.
          const refused = await refusal(
            stampTarget(
              migrator,
              stamp(migrator, target, { databaseOid: '1' }),
              migrator.facts.systemIdentifier,
            ),
          )
          expect(refused).toMatchObject({ reason: 'database_mismatch' })
          const schema = await migrator.query(
            sql`SELECT count(*)::int AS n FROM pg_catalog.pg_namespace WHERE nspname = 'exponetdb'`,
          )
          expect(schema[0]?.int('n')).toBe(0)
        } finally {
          await migrator.close()
        }
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('refuses a Control Store, by its catalog signs, whatever the database is called', async () => {
      const db = await prepareDatabase(server, `reg_cs_${server.major}`, undefined, [
        'CREATE SCHEMA control',
        'CREATE TABLE control.installation (installation_id text)',
      ])
      try {
        const migrator = await open(server, db, 'migrator')
        try {
          const e = await refusal(
            stampTarget(migrator, stamp(migrator, target), migrator.facts.systemIdentifier),
          )
          expect(e).toMatchObject({ reason: 'control_store' })
          expect(await readMarker(migrator)).toEqual({ status: 'absent' })
        } finally {
          await migrator.close()
        }
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('refuses an exponetdb schema without a marker (someone else made it)', async () => {
      const db = await prepareDatabase(server, `reg_sch_${server.major}`, undefined, [
        'CREATE SCHEMA exponetdb',
      ])
      try {
        const migrator = await open(server, db, 'migrator')
        try {
          const e = await refusal(
            stampTarget(migrator, stamp(migrator, target), migrator.facts.systemIdentifier),
          )
          expect(e).toMatchObject({ reason: 'schema_exists_without_marker' })
        } finally {
          await migrator.close()
        }
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('serializes concurrent registrations: one stamps, the other waits or retries harmlessly', async () => {
      const db = await prepareDatabase(server, `reg_conc_${server.major}`)
      try {
        const run = async () => {
          const m = await open(server, db, 'migrator')
          try {
            const release = await takeSchemaLock(m, target, 10_000)
            try {
              return (await stampTarget(m, stamp(m, target), m.facts.systemIdentifier)).status
            } finally {
              await release()
            }
          } finally {
            await m.close()
          }
        }
        // Two at once: the migrator's role connection limit (2) is part of the model.
        const outcomes = (await Promise.all([run(), run()])).sort()
        expect(outcomes).toEqual(['already_stamped', 'stamped'])
        expect(await run()).toBe('already_stamped')
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('keeps the ledger readable when an event trigger enables row security on new tables', async () => {
      const db = await prepareDatabase(server, `reg_evt_${server.major}`, SHAPED)
      try {
        const migrator = await open(server, db, 'migrator')
        await stampTarget(migrator, stamp(migrator, target), migrator.facts.systemIdentifier)
        await migrator.close()
        const observer = await open(server, db, 'observer')
        try {
          expect((await readMarker(observer)).status).toBe('present')
          const shape = await ledgerShape(observer)
          expect(shape.rowSecurity).toEqual([])
          expect(isEmptyLedger(shape)).toBe(true)
        } finally {
          await observer.close()
        }
      } finally {
        await dropDatabase(server, db)
      }
    })

    it('protects the marker and the ledger: append-only, no role but the migrator writes', async () => {
      const db = await prepareDatabase(server, `reg_imm_${server.major}`)
      try {
        const migrator = await open(server, db, 'migrator')
        await stampTarget(migrator, stamp(migrator, target), migrator.facts.systemIdentifier)
        for (const attempt of [
          sql`DELETE FROM exponetdb.target_identity`,
          sql`UPDATE exponetdb.target_identity SET installation_id = 'ins_other'`,
          sql`UPDATE exponetdb.target_identity SET generation = 0`,
          sql`DELETE FROM exponetdb.ledger_meta`,
          sql`DROP TABLE exponetdb.target_identity`,
          sql`TRUNCATE exponetdb.target_identity`,
        ]) {
          const e = await refusal(migrator.transaction(() => migrator.query(attempt)))
          expect(e).toBeInstanceOf(TargetError)
          expect(['PERMISSION_DENIED', 'TARGET_SQL_ERROR', 'QUERY_PARSE_ERROR']).toContain(
            (e as TargetError).code,
          )
        }
        await migrator.close()
        const observer = await open(server, db, 'observer')
        try {
          await observer.query(
            sql`SELECT pg_catalog.set_config('default_transaction_read_only', 'off', false)`,
          )
          const e = await refusal(
            observer.query(
              sql`INSERT INTO exponetdb.ledger_meta (ledger_schema_version, project_id, created_at) VALUES (2, 'x', now())`,
            ),
          )
          expect((e as TargetError).sqlstate).toBe('42501')
        } finally {
          await observer.close()
        }
        // Even the superuser's change of the marker's identity is refused by the trigger.
        await expect(
          runAsSuperuser(server, db, ["UPDATE exponetdb.target_identity SET target_id = 'tgt_x'"]),
        ).rejects.toThrow(/identity marker/)
      } finally {
        await dropDatabase(server, db)
      }
    })
  },
)

async function takeSnapshotOf(server: Parameters<typeof open>[0], db: string): Promise<string> {
  const s = await open(server, db, 'observer')
  try {
    return (await takeSnapshot(s)).fingerprint
  } finally {
    await s.close()
  }
}
