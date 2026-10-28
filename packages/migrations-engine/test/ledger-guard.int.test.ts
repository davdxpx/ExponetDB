import type { OperationRecord, PlanRecord } from '@exponetdb/operations'
import type { RegistryActor } from '@exponetdb/registry'
import { serverFor, superuserClient, type TestServer } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { operationError } from '../../registry/test/harness.ts'
import { DEFERRED_TRIGGER_ROUNDS, planMigrationApply, readProgress } from '../src/index.ts'
import { DEFAULTS, migrationWorld, OWNER, type Target, type World } from './world.ts'

/**
 * The ledger guard of the executor (OD-55 (d), planning-and-apply.md §4.3,
 * threat T38) on real PostgreSQL 16, 17 and 18: procedural code in an
 * authored statement switches to a role the migrator holds (the migrator
 * itself, the ledger owner), changes the target's ledger or identity
 * marker, and switches back, unseen by the role guard. The executor
 * compares the ledger tables and the `exponetdb` schema's shape before the
 * first statement and after each one inside the migration's transaction
 * and rolls back what it did not write itself; the target is unchanged.
 * A normal bundle still applies, and a concurrent writer of verification
 * runs waits for the migration's COMMIT instead of tripping the guard.
 */
type Client = Awaited<ReturnType<typeof superuserClient>>

/** What the guard protects, read independently by the superuser. */
async function ledgerState(server: TestServer, t: Target): Promise<string> {
  const c = await superuserClient(server, t.database)
  try {
    const parts: string[] = []
    for (const table of [
      'target_identity',
      'ledger_meta',
      'schema_migrations',
      'migration_verifications',
      'migration_events',
    ]) {
      const r = await c.query(
        `SELECT count(*)::int AS n, coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), '') AS d
           FROM exponetdb.${table} t`,
      )
      parts.push(`${table}:${r.rows[0].n}:${r.rows[0].d}`)
    }
    return parts.join('|')
  } finally {
    await c.end()
  }
}

async function relationExists(server: TestServer, t: Target, name: string): Promise<boolean> {
  const c = await superuserClient(server, t.database)
  try {
    const r = await c.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name])
    return r.rows[0].ok === true
  } finally {
    await c.end()
  }
}

/** Back to the execution role at the end of a block, as an attacker would do to pass the role guard. */
const BACK = `EXECUTE 'SET ROLE ${OWNER}';`

function suite(major: 16 | 17 | 18, full: boolean) {
  describe(`PostgreSQL ${major}`, () => {
    const server = serverFor(major)
    let w: World
    let t: Target
    let base = ''

    async function refusedUnchanged(up: string, changed: RegExp, statementIndex: number | null) {
      const before = await ledgerState(server, t)
      const op: OperationRecord = await w.apply(
        await w.plan(t, {
          bundles: [w.bundle({ up, dependsOn: [base], declared: 'potentially_breaking' })],
        }),
      )
      expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
      expect((await operationError(w.h, op.operationId)).code).toBe('MIGRATION_EXECUTION_FAILED')
      const progress = (await readProgress(w.h.worker, op.operationId))[0]
      expect(progress).toMatchObject({
        applyOutcome: 'not_applied',
        errorCode: 'MIGRATION_EXECUTION_FAILED',
        statementIndex,
        gate: { guard: 'exponetdb_ledger' },
      })
      expect(String(progress?.gate?.['changed'])).toMatch(changed)
      // Rolled back: the ledger, the marker and the schema are as before.
      expect(await ledgerState(server, t)).toBe(before)
      expect(await relationExists(server, t, 'public.guard_probe')).toBe(false)
      return op
    }

    beforeAll(async () => {
      w = await migrationWorld(`exdb_it_mig_guard_${major}`, server)
      t = await w.registerTarget(`guard-${major}`, 'nonprod')
      base = w.ulid()
      const op = await w.apply(
        await w.plan(t, {
          bundles: [
            w.bundle({ id: base, name: 'items', up: 'CREATE TABLE public.items (id int);\n' }),
          ],
        }),
      )
      expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    }, 240_000)

    afterAll(async () => {
      await w?.close()
    })

    it('applies a normal bundle with procedural statements that leave the ledger alone', async () => {
      const id = w.ulid()
      const op = await w.apply(
        await w.plan(t, {
          bundles: [
            w.bundle({
              id,
              name: 'normal',
              dependsOn: [base],
              up: [
                'CREATE TABLE public.normal_rows (id int PRIMARY KEY);',
                "DO $$ BEGIN EXECUTE format('INSERT INTO public.normal_rows VALUES (%s)', 1); END $$;",
                'GRANT SELECT ON public.normal_rows TO PUBLIC;',
                '',
              ].join('\n'),
            }),
          ],
        }),
      )
      expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
      expect(await relationExists(server, t, 'public.normal_rows')).toBe(true)
    }, 120_000)

    it('refuses a DO block that resets to the migrator and appends a ledger event', async () => {
      await refusedUnchanged(
        [
          'CREATE TABLE public.guard_probe (id int);',
          `DO $$ BEGIN EXECUTE 'RESET ROLE';
  INSERT INTO exponetdb.migration_events (migration_id, operation_id, event)
    VALUES ('forged', 'opr_forged', 'applied');
  ${BACK} END $$;`,
          '',
        ].join('\n'),
        /migration_events/,
        1,
      )
    }, 120_000)

    if (!full) return

    it('refuses dynamic EXECUTE that forges an applied migration and changes the marker', async () => {
      await refusedUnchanged(
        [
          'CREATE TABLE public.guard_probe (id int);',
          `DO $$ BEGIN EXECUTE 'RESET ROLE';
  EXECUTE format('INSERT INTO exponetdb.schema_migrations (migration_id, origin, name, checksum,
      checksum_provenance, applied_at, operation_id, engine_version, pg_version_num)
    VALUES (%L, ''exponetdb'', ''forged'', ''sha256:c1:00'', ''computed_at_apply'', now(), ''opr_x'', ''x'', 170000)',
    '01M5X840BQEDCSCF9ADCZCFW5S');
  EXECUTE 'UPDATE exponetdb.target_identity SET target_path = target_path || ''-forged''';
  ${BACK} END $$;`,
          '',
        ].join('\n'),
        /target_identity,schema_migrations/,
        1,
      )
    }, 120_000)

    it('refuses a SECURITY DEFINER function of the ledger owner that a later statement calls', async () => {
      // The adversary's best case: the ledger owner may create in public.
      const c: Client = await superuserClient(server, t.database)
      try {
        await c.query('GRANT CREATE ON SCHEMA public TO exponetdb_ledger_owner')
      } finally {
        await c.end()
      }
      await refusedUnchanged(
        [
          'CREATE TABLE public.guard_probe (id int);',
          `DO $$ BEGIN EXECUTE 'SET ROLE exponetdb_ledger_owner';
  EXECUTE $f$CREATE FUNCTION public.guard_forge() RETURNS void LANGUAGE sql SECURITY DEFINER
    SET search_path = '' AS 'UPDATE exponetdb.ledger_meta SET baseline_id = ''forged'''$f$;
  ${BACK} END $$;`,
          'SELECT public.guard_forge();',
          '',
        ].join('\n'),
        /ledger_meta/,
        2,
      )
    }, 120_000)

    it('refuses a trigger of the ledger disabled and enabled again (the shape)', async () => {
      await refusedUnchanged(
        [
          'CREATE TABLE public.guard_probe (id int);',
          `DO $$ BEGIN EXECUTE 'SET ROLE exponetdb_ledger_owner';
  EXECUTE 'ALTER TABLE exponetdb.migration_events DISABLE TRIGGER migration_events_change';
  EXECUTE 'ALTER TABLE exponetdb.migration_events ENABLE TRIGGER migration_events_change';
  ${BACK} END $$;`,
          '',
        ].join('\n'),
        /shape/,
        1,
      )
    }, 120_000)

    it('refuses a deferred trigger that would write the ledger at COMMIT, after the checks', async () => {
      await refusedUnchanged(
        [
          'CREATE TABLE public.guard_probe (id int);',
          `CREATE FUNCTION public.guard_late() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  INSERT INTO exponetdb.migration_events (migration_id, operation_id, event)
    VALUES ('late', 'opr_late', 'applied');
  ${BACK}
  RETURN NULL;
END $$;`,
          `CREATE CONSTRAINT TRIGGER guard_late AFTER INSERT ON public.guard_probe
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_late();`,
          'INSERT INTO public.guard_probe VALUES (1);',
          '',
        ].join('\n'),
        /migration_events/,
        null,
      )
    }, 120_000)

    /** A deferred trigger that defers constraints again and queues the next link until `last`, which writes the ledger. */
    const redeferring = (last: number) =>
      [
        'CREATE TABLE public.guard_probe (id int);',
        `CREATE FUNCTION public.guard_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id < ${last} THEN
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO public.guard_probe VALUES (NEW.id + 1);
  ELSE
    EXECUTE 'RESET ROLE';
    INSERT INTO exponetdb.migration_events (migration_id, operation_id, event)
      VALUES ('late', 'opr_late', 'applied');
    ${BACK}
  END IF;
  RETURN NULL;
END $$;`,
        `CREATE CONSTRAINT TRIGGER guard_chain AFTER INSERT ON public.guard_probe
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.guard_chain();`,
        'INSERT INTO public.guard_probe VALUES (1);',
        '',
      ].join('\n')

    it('refuses a deferred trigger that defers again to reach COMMIT after the checks (review E-1)', async () => {
      await refusedUnchanged(redeferring(4), /migration_events/, null)
    }, 120_000)

    it('refuses a chain of deferred triggers longer than the bound, whatever it writes (review E-1)', async () => {
      const before = await ledgerState(server, t)
      const op: OperationRecord = await w.apply(
        await w.plan(t, {
          bundles: [
            w.bundle({
              up: redeferring(DEFERRED_TRIGGER_ROUNDS + 4),
              dependsOn: [base],
              declared: 'potentially_breaking',
            }),
          ],
        }),
      )
      expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_applied' })
      const progress = (await readProgress(w.h.worker, op.operationId))[0]
      expect(progress?.gate).toEqual({ guard: 'exponetdb_ledger', check: 'deferred_trigger_chain' })
      expect(await ledgerState(server, t)).toBe(before)
      expect(await relationExists(server, t, 'public.guard_probe')).toBe(false)
    }, 120_000)

    it('classifies the plan and asks a person for an agent plan with procedural SQL on nonprod (OD-55 (c))', async () => {
      const agent: RegistryActor = { ...w.a, client: 'mcp', reauthAt: null }
      const planAs = (by: RegistryActor, up: string, transactional = true) =>
        w.h.serve.transaction('test.guard.plan_as', (tx) =>
          planMigrationApply(tx, w.ctx, by, t.record.targetId, {
            defaults: DEFAULTS,
            lintProfile: 'standard',
            bundles: [w.bundle({ up, dependsOn: [base], transactional })],
          } as never),
        )
      const facts = (p: PlanRecord) =>
        (p.body['content'] as { facts: Record<string, unknown> }).facts
      const rule = (p: PlanRecord, id: string) =>
        (p.body['policy'] as { rules: { id: string; result: string }[] }).rules.find(
          (r) => r.id === id,
        )?.result
      const cases: [string, readonly string[]][] = [
        ["DO $$ BEGIN EXECUTE format('SELECT %s', 1); END $$;\n", ['do_block', 'dynamic_sql']],
        [
          'CREATE FUNCTION public.guard_f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nSELECT public.guard_f();\n',
          ['function_call', 'routine_created'],
        ],
        [
          "CREATE TABLE public.guard_q (id int);\nINSERT INTO public.guard_q SELECT 1 FROM pg_catalog.query_to_xml('SELECT 1', true, true, '') x;\n",
          ['dynamic_sql'],
        ],
      ]
      for (const [up, reasons] of cases) {
        const byAgent = await planAs(agent, up)
        expect(facts(byAgent), up).toMatchObject({ procedural: true, proceduralReasons: reasons })
        expect(rule(byAgent, 'migration.agent-procedural'), up).toBe('fail')
        expect(byAgent.decision, up).toBe('require')
        const byPerson = await planAs(w.a, up)
        expect(rule(byPerson, 'migration.agent-procedural'), up).toBe('not_applicable')
      }
      const plain = await planAs(agent, 'CREATE TABLE public.guard_plain (id int);\n')
      expect(facts(plain)).toMatchObject({ procedural: false, proceduralReasons: [] })
      expect(rule(plain, 'migration.agent-procedural')).toBe('pass')
      // Non-transactional: the guard cannot roll back, so procedural SQL there is refused for a
      // person too.
      const nontx = await planAs(
        w.a,
        'CREATE INDEX CONCURRENTLY guard_items_idx ON public.items (id);\nDO $$ BEGIN NULL; END $$;\n',
        false,
      )
      expect(rule(nontx, 'migration.procedural-nontransactional')).toBe('fail')
      expect(nontx.decision).toBe('deny')
    }, 120_000)

    it('lets a concurrent verification run wait for the COMMIT instead of tripping the guard', async () => {
      const id = w.ulid()
      const p = await w.plan(t, {
        bundles: [
          w.bundle({
            id,
            name: 'slow',
            dependsOn: [base],
            up: 'CREATE TABLE public.slow_rows (id int);\nDO $$ BEGIN PERFORM pg_sleep(2); END $$;\n',
          }),
        ],
      })
      const watcher = await superuserClient(server, t.database)
      const writer = await superuserClient(server, t.database)
      try {
        const applying = w.apply(p)
        // The migration is inside its sleep, holding SHARE on the ledger tables.
        for (let i = 0; i < 100; i++) {
          const r = await watcher.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event = 'PgSleep'`,
          )
          if (r.rows[0].n > 0) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        const insert = writer.query(
          `INSERT INTO exponetdb.migration_verifications (verification_id, migration_id, operation_id,
             started_at, finished_at, status, structural, engine, fingerprint)
           VALUES ('vr_concurrent_${major}', $1, 'opr_concurrent', now(), now(), 'passed', '{}', '{}', 'x')`,
          [base],
        )
        let waited = false
        for (let i = 0; i < 40 && !waited; i++) {
          const r = await watcher.query(
            'SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1 AND NOT granted',
            [pid],
          )
          waited = r.rows[0].n > 0
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const op = await applying
        await insert
        expect(waited).toBe(true)
        expect(op).toMatchObject({ state: 'succeeded', applyOutcome: 'applied' })
        const r = await watcher.query(
          `SELECT count(*)::int AS n FROM exponetdb.migration_verifications
            WHERE verification_id = 'vr_concurrent_${major}'`,
        )
        expect(r.rows[0].n).toBe(1)
      } finally {
        await watcher.end()
        await writer.end()
      }
    }, 120_000)
  })
}

suite(17, true)
suite(16, true)
suite(18, true)
