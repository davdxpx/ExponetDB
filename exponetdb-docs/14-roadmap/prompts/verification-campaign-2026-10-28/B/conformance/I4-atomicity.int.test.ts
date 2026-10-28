// I4 Atomicity at apply level, on real PostgreSQL 16, 17 and 18 through the engine's own entry points
// (planMigrationApply -> acceptPlan -> worker -> runTransactional): a transactional bundle is applied fully
// with its ledger row or not at all, and `up.sql` cannot end the transaction early. For every hazard the
// outcome is classified:
//   refused@plan        lint / plan refused the bundle (the best answer)
//   failed@apply        the server or the engine's guards stopped it; nothing may persist
//   applied             the bundle ran; then ledger row and ALL its effects must be present
// and the invariant "table-before and table-after exist iff the ledger row exists" is asserted for each.
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { MigrationError } from '@exponetdb/migrations-engine'
import { readLedgerRows } from '@exponetdb/postgres'
import { superuserClient, type TestServer } from '@exponetdb/testkit'
import { operationError } from './lib/world.ts'
import { MAJORS, type Major } from './lib/pg.ts'
import { migrationWorld, type Target, type World } from './lib/world.ts'
import { serverFor } from '@exponetdb/testkit'

type Outcome =
  | { kind: 'refused'; code: string; rules: string[] }
  | { kind: 'failed'; errorCode: string; applyOutcome: string }
  | { kind: 'applied' }

interface Ctx {
  w: World
  t: Target
  server: TestServer
  n: number
}

async function superuser<T>(ctx: Ctx, fn: (c: Awaited<ReturnType<typeof superuserClient>>) => Promise<T>): Promise<T> {
  const c = await superuserClient(ctx.server, ctx.t.database)
  try {
    return await fn(c)
  } finally {
    await c.end()
  }
}

async function tableExists(ctx: Ctx, name: string): Promise<boolean> {
  return superuser(ctx, async (c) => (await c.query('SELECT to_regclass($1) IS NOT NULL AS e', [`public.${name}`])).rows[0]?.e === true)
}

async function ledgerHas(ctx: Ctx, id: string): Promise<boolean> {
  const opened = await ctx.w.h.workerConnector.forTarget(ctx.t.record, 'observer', 'b2-test')
  try {
    const rows = await opened.session.readOnly((tx) => readLedgerRows(tx))
    return rows.some((r) => r.migrationId === id)
  } finally {
    await opened.session.close()
  }
}

interface Attempt {
  outcome: Outcome
  before: boolean
  after: boolean
  ledger: boolean
  id: string
}

/** One bundle `CREATE before; <hazard>; CREATE after`, planned and applied; the world is inspected afterwards. */
async function attempt(ctx: Ctx, hazard: string, opts: { transactional?: boolean; dependsOn?: string[]; wrap?: boolean; declared?: string } = {}): Promise<Attempt> {
  const k = ++ctx.n
  const id = ctx.w.ulid()
  const up = opts.wrap === false ? hazard : `CREATE TABLE public.before_${k} (i int);\n${hazard}\nCREATE TABLE public.after_${k} (i int);\n`
  let outcome: Outcome
  try {
    const p = await ctx.w.plan(ctx.t, {
      bundles: [ctx.w.bundle({ id, name: `h${k}`, up, transactional: opts.transactional ?? true, ...(opts.declared === undefined ? {} : { declared: opts.declared }), ...(opts.dependsOn === undefined ? {} : { dependsOn: opts.dependsOn }) })],
    })
    if (p.state === 'denied' || p.decision === 'deny') {
      // A blocked plan is stored "for explanation only"; accepting it is PLAN_DENIED. That is a refusal at plan time.
      const rules = JSON.stringify((p.body as Record<string, unknown>)['policy'] ?? '').match(/migration\.[a-z0-9_.-]+/g) ?? []
      outcome = { kind: 'refused', code: 'PLAN_DENIED', rules: [...new Set(rules)] }
      return { outcome, before: await tableExists(ctx, `before_${k}`), after: await tableExists(ctx, `after_${k}`), ledger: await ledgerHas(ctx, id), id }
    }
    const op = await ctx.w.apply(p)
    if (op.state === 'succeeded' && op.applyOutcome === 'applied') outcome = { kind: 'applied' }
    else outcome = { kind: 'failed', errorCode: (await operationError(ctx.w.h, op.operationId)).code ?? 'none', applyOutcome: String(op.applyOutcome) }
  } catch (e) {
    if (e instanceof Error && e.name === 'OperationError') {
      outcome = { kind: 'refused', code: (e as unknown as { code: string }).code, rules: [] }
    } else if (e instanceof MigrationError) {
      const d = (e as unknown as { details?: { findings?: { rule: string }[] } }).details
      outcome = { kind: 'refused', code: e.code, rules: (d?.findings ?? []).map((f) => f.rule) }
    } else throw e
  }
  return { outcome, before: await tableExists(ctx, `before_${k}`), after: await tableExists(ctx, `after_${k}`), ledger: await ledgerHas(ctx, id), id }
}

function assertAtomic(a: Attempt, label: string) {
  // all-or-nothing: the two tables and the ledger row appear together or not at all
  expect([a.before, a.after, a.ledger], `${label}: before/after/ledger must be all true or all false`).toSatisfy((v: boolean[]) => v.every(Boolean) || v.every((x) => !x))
}

describe.each(MAJORS)('I4 atomicity on PostgreSQL %i', (major: Major) => {
  const ctx = {} as Ctx
  beforeAll(async () => {
    ctx.server = serverFor(major)
    ctx.w = await migrationWorld(`b2_i4_${major}`, ctx.server)
    ctx.t = await ctx.w.registerTarget('i4', 'nonprod')
    ctx.n = 0
  }, 300_000)
  afterAll(async () => {
    await ctx.w?.close()
  })

  test('control: a plain two-statement bundle applies with its ledger row', async () => {
    const a = await attempt(ctx, 'COMMENT ON TABLE public.before_1 IS \'x\';')
    expect(a.outcome.kind).toBe('applied')
    assertAtomic(a, 'control')
    expect(a.ledger).toBe(true)
  })

  // ---- hazards the classifier cannot see (they live in function bodies): the engine's guards and PostgreSQL decide ----
  const BODY_HAZARDS: [string, string][] = [
    ['DO with COMMIT', 'DO $$ BEGIN COMMIT; END $$;'],
    ['DO with EXECUTE COMMIT', "DO $$ BEGIN EXECUTE 'COMMIT'; END $$;"],
    ['DO with ROLLBACK', 'DO $$ BEGIN ROLLBACK; END $$;'],
    ['DO with EXECUTE ROLLBACK', "DO $$ BEGIN EXECUTE 'ROLLBACK'; END $$;"],
    ['DO with SAVEPOINT', "DO $$ BEGIN EXECUTE 'SAVEPOINT s'; EXECUTE 'RELEASE s'; END $$;"],
    ['single-quoted DO body with COMMIT', "DO 'BEGIN COMMIT; END';"],
    ['E-string DO body with COMMIT', "DO E'BEGIN COMMIT; END';"],
    ['procedure that commits', 'CREATE PROCEDURE public.p_commit() LANGUAGE plpgsql AS $$ BEGIN COMMIT; END $$;\nCALL public.p_commit();'],
    ['procedure that rolls back', 'CREATE PROCEDURE public.p_rb() LANGUAGE plpgsql AS $$ BEGIN ROLLBACK; END $$;\nCALL public.p_rb();'],
    ['DO with SET LOCAL ROLE to a superuser', 'DO $$ BEGIN SET LOCAL ROLE postgres; END $$;'],
    ['DO with RESET ROLE then DDL as the migrator', 'DO $$ BEGIN RESET ROLE; CREATE TABLE public.as_migrator (i int); END $$;'],
    ['DO with SET LOCAL ROLE ledger owner and DELETE of the ledger', 'DO $$ BEGIN SET LOCAL ROLE exponetdb_ledger_owner; DELETE FROM exponetdb.schema_migrations; END $$;'],
    ['DO with RESET ROLE and a forged ledger row', "DO $$ BEGIN RESET ROLE; INSERT INTO exponetdb.migration_events (migration_id, operation_id, event, detail) VALUES ('forged', 'op_x', 'applied', '{}'); END $$;"],
    ['function that turns standard_conforming_strings off', "CREATE FUNCTION public.f_scs() RETURNS int LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('standard_conforming_strings','off',true); RETURN 1; END $$;\nSELECT public.f_scs();"],
    ['DO that changes search_path', "DO $$ BEGIN PERFORM set_config('search_path','pg_temp,public',true); END $$;"],
    ['DO that changes lock_timeout', "DO $$ BEGIN PERFORM set_config('lock_timeout','0',true); END $$;"],
    ['DO that changes statement_timeout', "DO $$ BEGIN PERFORM set_config('statement_timeout','0',true); END $$;"],
    ['DO that changes session_replication_role', "DO $$ BEGIN PERFORM set_config('session_replication_role','replica',true); END $$;"],
    ['DO that makes the transaction read only', "DO $$ BEGIN PERFORM set_config('transaction_read_only','on',true); END $$;"],
    ['DO that sets row_security off (ENGINE_SETTINGS lists it, the guard does not read it)', "DO $$ BEGIN PERFORM set_config('row_security','off',true); END $$;"],
    ['DO that changes extra_float_digits (ENGINE_SETTINGS lists it, the guard does not read it)', "DO $$ BEGIN PERFORM set_config('extra_float_digits','-15',true); END $$;"],
    ['DO that changes application_name (ENGINE_SETTINGS lists it, the guard does not read it)', "DO $$ BEGIN PERFORM set_config('application_name','not-exponetdb',true); END $$;"],
    ['DO that changes default_tablespace (ENGINE_SETTINGS lists it, the guard does not read it)', "DO $$ BEGIN PERFORM set_config('default_tablespace','pg_default',true); END $$;"],
    ['DO that changes temp_tablespaces (ENGINE_SETTINGS lists it, the guard does not read it)', "DO $$ BEGIN PERFORM set_config('temp_tablespaces','pg_default',true); END $$;"],
    ['DO that changes default_transaction_read_only (ENGINE_SETTINGS lists it, the guard does not read it)', "DO $$ BEGIN PERFORM set_config('default_transaction_read_only','on',true); END $$;"],
    ['DO that changes transaction_timeout (PostgreSQL 17+; ENGINE_SETTINGS lists it, the guard does not read it)', "DO $$ BEGIN PERFORM set_config('transaction_timeout','0',true); END $$;"],
    ['function with a SET clause on a pinned setting', "CREATE FUNCTION public.f_clause() RETURNS int LANGUAGE sql SET standard_conforming_strings = off AS $$ SELECT 1 $$;\nSELECT public.f_clause();"],
    ['terminates its own backend', 'SELECT pg_terminate_backend(pg_backend_pid());'],
    ['cancels its own backend', 'SELECT pg_cancel_backend(pg_backend_pid());'],
    ['reloads the configuration', 'SELECT pg_reload_conf();'],
    ['statement that errors in the middle', 'SELECT 1/0;'],
    ['DO with an exception handler swallowing the error', "DO $$ BEGIN BEGIN PERFORM 1/0; EXCEPTION WHEN others THEN NULL; END; END $$;"],
    ['two-phase: PREPARE TRANSACTION through EXECUTE', "DO $$ BEGIN EXECUTE $q$PREPARE TRANSACTION 'x'$q$; END $$;"],
    ['advisory lock release of all locks', 'SELECT pg_advisory_unlock_all();'],
  ]
  for (const [name, hazard] of BODY_HAZARDS) {
    test(`body hazard: ${name}: atomic, and never a ledger row without the effects`, async () => {
      const a = await attempt(ctx, hazard)
      assertAtomic(a, name)
      console.log(`I4[pg${major}] ${name}: ${JSON.stringify(a.outcome)} before=${a.before} after=${a.after} ledger=${a.ledger}`)
      // forged / role-escape cases must never be applied
      if (/ledger|SET LOCAL ROLE|RESET ROLE|search_path|scs|standard_conforming|read only|row_security|extra_float|application_name|tablespace|default_transaction|transaction_timeout|lock_timeout|statement_timeout|session_replication/i.test(name)) {
        expect(a.outcome.kind, `${name} must not be applied`).not.toBe('applied')
      }
      if (/COMMIT|ROLLBACK|SAVEPOINT|PREPARE|terminates|cancels|errors in the middle/i.test(name) && !/swallowing/.test(name)) {
        expect(a.outcome.kind, `${name} must not be applied`).not.toBe('applied')
      }
    })
  }

  test('up.sql cannot release the engine\'s own target lock (pg_advisory_unlock_all): single writer holds for the whole migration', async () => {
    const EXDB = 1163412546 // key1 of every ExponetDB advisory lock: ASCII "EXDB"
    const holders = () =>
      superuser(ctx, async (c) => Number((await c.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = $1", [EXDB])).rows[0]?.n))
    const during = async (hazard: string): Promise<number> => {
      const k = ++ctx.n
      const id = ctx.w.ulid()
      const p = await ctx.w.plan(ctx.t, { bundles: [ctx.w.bundle({ id, name: `lk${k}`, up: `${hazard}\nSELECT pg_sleep(4);\n` })] })
      const running = ctx.w.apply(p)
      let seen = -1
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 250))
        const a = await superuser(ctx, async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND pid <> pg_backend_pid() AND state = 'active'")).rows[0]?.n as number)
        if (a > 0) {
          await new Promise((r) => setTimeout(r, 800))
          seen = await holders()
          break
        }
      }
      await running
      return seen
    }
    const baseline = await during('SELECT 1;')
    const released = await during('SELECT pg_advisory_unlock_all();')
    console.log(`I4[pg${major}] EXDB advisory locks held while the migration runs: baseline=${baseline}, after pg_advisory_unlock_all()=${released}`)
    expect(baseline, 'the engine holds its lock during a migration').toBeGreaterThan(0)
    expect(released, 'up.sql released the engine lock: another writer could start on this target').toBeGreaterThan(0)
  })

  // ---- statements the classifier must catch at plan time ----
  const LINT_HAZARDS: [string, string][] = [
    ['COMMIT', 'COMMIT;'],
    ['ROLLBACK', 'ROLLBACK;'],
    ['SAVEPOINT', 'SAVEPOINT s;'],
    ['BEGIN', 'BEGIN;'],
    ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION postgres;'],
    ['RESET ROLE', 'RESET ROLE;'],
    ['SET search_path', 'SET search_path = pg_temp;'],
    ['SET LOCAL search_path', 'SET LOCAL search_path = pg_temp;'],
    ['SET LOCAL standard_conforming_strings', 'SET LOCAL standard_conforming_strings = off;'],
    ['set_config pinned', "SELECT set_config('standard_conforming_strings','off',true);"],
    ['ALTER SYSTEM', 'ALTER SYSTEM SET work_mem = 1;'],
    ['psql meta-command', '\\connect postgres'],
    ['CREATE INDEX CONCURRENTLY', 'CREATE INDEX CONCURRENTLY idx_c ON public.before_1 (i);'],
    ['VACUUM', 'VACUUM public.before_1;'],
    ['CREATE DATABASE', 'CREATE DATABASE nope;'],
  ]
  for (const [name, hazard] of LINT_HAZARDS) {
    test(`lint hazard: ${name}: refused at plan time, nothing applied`, async () => {
      const a = await attempt(ctx, hazard)
      expect(a.outcome.kind, `${name}: ${JSON.stringify(a.outcome)}`).toBe('refused')
      expect([a.before, a.after, a.ledger]).toEqual([false, false, false])
    })
  }

  test('CREATE INDEX CONCURRENTLY in a NON-transactional bundle of its own is planned and applied alone', async () => {
    const a0 = await attempt(ctx, 'SELECT 1;')
    expect(a0.outcome.kind).toBe('applied')
    const table = `before_${ctx.n}`
    const a = await attempt(ctx, `CREATE INDEX CONCURRENTLY idx_${ctx.n} ON public.${table} (i);`, { transactional: false, wrap: false, dependsOn: [a0.id] })
    expect(a.outcome, JSON.stringify(a.outcome)).toEqual({ kind: 'applied' })
    expect(a.ledger).toBe(true)
  })

  test('DETACH PARTITION ... CONCURRENTLY cannot run in a transaction block: it must be refused at lint time (or be expressible non-transactionally)', async () => {
    const setup = await attempt(ctx, 'CREATE TABLE public.part_p (i int) PARTITION BY RANGE (i);\nCREATE TABLE public.part_p1 PARTITION OF public.part_p FOR VALUES FROM (0) TO (10);', { wrap: false })
    expect(setup.outcome.kind).toBe('applied')
    const tx = await attempt(ctx, 'ALTER TABLE public.part_p DETACH PARTITION public.part_p1 CONCURRENTLY;', { wrap: false, dependsOn: [setup.id], declared: 'potentially_breaking' })
    console.log(`I4[pg${major}] DETACH CONCURRENTLY in a transactional bundle: ${JSON.stringify(tx.outcome)}`)
    // Expected by migration-bundles.md §5: "the parser classifies these; a mismatch is a blocking lint"
    // (nontransactional_statement_in_transactional). A late server error is atomic but not a lint answer.
    expect(tx.outcome.kind, `outcome: ${JSON.stringify(tx.outcome)}`).toBe('refused')
    const nontx = await attempt(ctx, 'ALTER TABLE public.part_p DETACH PARTITION public.part_p1 CONCURRENTLY;', { wrap: false, transactional: false, dependsOn: [setup.id], declared: 'potentially_breaking' })
    expect(nontx.outcome, `a non-transactional bundle must be able to carry it: ${JSON.stringify(nontx.outcome)}`).toEqual({ kind: 'applied' })
  })

  test('ALTER TYPE ... ADD VALUE used in the same transaction is stopped (lint or server), never half applied', async () => {
    const a = await attempt(ctx, "CREATE TYPE public.mood AS ENUM ('sad');\nALTER TYPE public.mood ADD VALUE 'ok';\nSELECT 'ok'::public.mood;")
    assertAtomic(a, 'enum add value')
    expect(a.outcome.kind).not.toBe('applied')
  })
})
