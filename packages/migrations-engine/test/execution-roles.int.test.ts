import type { DispatchAdmission, PlanRecord } from '@exponetdb/operations'
import { RuleRegistry } from '@exponetdb/policy'
import {
  planEnvironmentCreate,
  planEnvironmentUpdate,
  planExecutionRoleBindings,
  planExecutionRoleExceptionDeclare,
  planExecutionRoleExceptionRevoke,
  planProjectUpdate,
  projectExecutionRoles,
  type RegistryActor,
} from '@exponetdb/registry'
import { runAsSuperuser, serverFor, type TestServer, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  operationError,
  planContent,
  plan as registryPlan,
  run,
} from '../../registry/test/harness.ts'
import { executionRolesFor } from '../src/execution-roles.ts'
import { planMigrationApply, planMigrationRollback, readProgress } from '../src/index.ts'
import { DEFAULTS, migrationWorld, OWNER, type Target, type World } from './world.ts'

/**
 * Execution roles for adopted schemas on real PostgreSQL 17
 * ([ADR-0034](../../../exponetdb-docs/01-architecture/adr/0034-execution-roles-for-adopted-schemas.md),
 * Wave 9 order A4, A5):
 *
 * - staging and production of one project on one cluster, each under its
 *   own owner role (a per-environment binding); production consumes the
 *   staging evidence of the same checksum although staging ran as another
 *   role, and a binding change between plan and apply is `PLAN_STALE`;
 * - an owner with `BYPASSRLS` is refused until a person declares the
 *   exception for that environment; the plan binds and shows it, an agent
 *   may apply it on nonprod, production still waits for a person, and a
 *   revocation between plan and apply is `PLAN_STALE`;
 * - a rollback checks its execution role like an apply.
 *
 * The roles of this suite are its own (pg17 is shared): the world's owner
 * is never altered.
 */
const pg17: TestServer = serverFor(17)
const suffix = Date.now().toString(36)
const PROD_OWNER = `exdb_it_er_prod_${suffix}`
const DEFINER = `exdb_it_er_definer_${suffix}`
const APP = `exdb_it_er_app_${suffix}`
const PROBE = `exdb_it_er_probe_${suffix}`
const REACHED = `exdb_it_er_reached_${suffix}`

/** A table change that passes the production lint profile (an explicit grant, a verify.sql). */
const table = (name: string) => ({
  up: `CREATE TABLE public.${name} (id int);\nGRANT SELECT ON public.${name} TO ${APP};\n`,
  verify: `-- check: readable\nSELECT count(*) >= 0 AS ok FROM public.${name};\n`,
})

let w: World
let staging: Target
let production: Target

interface Content {
  readonly expectedState: {
    readonly executionRoles: Record<string, string>
    readonly executionRoleExceptions?: Record<string, { exceptionId: string; revision: number }>
  }
  readonly migrations: readonly { readonly executionRole: string }[]
  readonly facts: {
    readonly evidence: string
    readonly requirementsUnmet: readonly string[]
    readonly executionRoleExceptions?: number
    readonly executionRoleParity?: string
    readonly lineage?: string
  }
}

const contentOf = (p: PlanRecord) => p.body['content'] as unknown as Content
const rules = (p: PlanRecord) =>
  (p.body['policy'] as { rules: { id: string; result: string }[] }).rules
const failed = (p: PlanRecord) =>
  rules(p)
    .filter((r) => r.result === 'fail')
    .map((r) => r.id)

const tableOwner = async (t: Target, table: string) =>
  withSuperuser(pg17, t.database, async (c) => {
    const r = await c.query(
      `SELECT tableowner FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    )
    return r.rows[0]?.tableowner as string | undefined
  })

/** Grants a role the way an adopter does: SET without INHERIT, and the schema it creates in. */
async function prepareRole(role: string, attributes: string, targets: readonly Target[]) {
  await runAsSuperuser(pg17, 'postgres', [
    `CREATE ROLE ${role} NOLOGIN ${attributes}`,
    `GRANT ${role} TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE`,
  ])
  for (const t of targets) {
    await runAsSuperuser(pg17, t.database, [`GRANT CREATE, USAGE ON SCHEMA public TO ${role}`])
  }
}

async function bind(t: Target, roles: Record<string, string>) {
  const r = await run(w.h, w.a, (tx) =>
    planExecutionRoleBindings(tx, w.h.context, w.a, t.record.projectId, t.record.environmentId, {
      roles,
    }),
  )
  expect(r.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
}

/**
 * Production declarations and revocations need an approval
 * (`registry.execution-role-exception-production`, asserted below); the
 * approval flow itself is tested with the auth package. Setup on production
 * plans them without registry rules, like the world's target registration.
 */
const unruled = () => ({
  ...w.h.context,
  policy: { ...w.h.context.policy, registry: new RuleRegistry([]) },
})
const contextFor = (t: Target) => (t.record.tier === 'prod' ? unruled() : w.h.context)

async function declare(t: Target, role: string): Promise<string> {
  const { plan: p, operation: op } = await run(w.h, w.a, (tx) =>
    planExecutionRoleExceptionDeclare(
      tx,
      contextFor(t),
      w.a,
      t.record.projectId,
      t.record.environmentId,
      { role, reason: 'Definer functions of the adopted schema read FORCE tables.' },
    ),
  )
  expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
  return String((p.body['content'] as Record<string, unknown>)['exceptionId'])
}

const revokePlan = (t: Target, exceptionId: string) =>
  registryPlan(w.h, (tx) =>
    planExecutionRoleExceptionRevoke(tx, contextFor(t), w.a, t.record.projectId, exceptionId, {
      reason: 'The definer functions moved to a dedicated role.',
    }),
  )

async function revoke(t: Target, exceptionId: string) {
  const { operation: op } = await run(w.h, w.a, () => revokePlan(t, exceptionId))
  expect(op).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
}

const agent = (): RegistryActor => ({ ...w.a, client: 'mcp', reauthAt: null })

const planAs = (by: RegistryActor, t: Target, request: Parameters<World['plan']>[1]) =>
  w.h.serve.transaction('test.er.plan_as', (tx) =>
    planMigrationApply(tx, w.ctx, by, t.record.targetId, {
      defaults: DEFAULTS,
      lintProfile: 'standard',
      ...request,
    } as never),
  )

beforeAll(async () => {
  w = await migrationWorld('exdb_it_exec_roles', pg17)
  staging = await w.registerTarget('staging', 'nonprod')
  production = await w.registerTarget('production', 'prod', 'staging')
  await prepareRole(PROD_OWNER, '', [staging, production])
  await prepareRole(DEFINER, 'BYPASSRLS', [staging, production])
  await runAsSuperuser(pg17, 'postgres', [`CREATE ROLE ${APP} NOLOGIN`])
})

afterAll(async () => {
  await w?.close()
  await runAsSuperuser(pg17, 'postgres', [
    `DROP ROLE IF EXISTS ${PROD_OWNER}`,
    `DROP ROLE IF EXISTS ${DEFINER}`,
    `DROP ROLE IF EXISTS ${APP}`,
    `DROP ROLE IF EXISTS ${PROBE}`,
    `DROP ROLE IF EXISTS ${REACHED}`,
  ]).catch(() => undefined)
})

describe('execution roles per environment (ADR-0034 §5)', () => {
  let first = ''

  it('runs staging and production of one cluster under their own roles; production consumes the staging evidence', async () => {
    await bind(production, { owner: PROD_OWNER })
    const b = w.bundle({ name: 'items', ...table('er_items') })
    first = b.directory.slice(0, 26)
    const onStaging = await w.plan(staging, { bundles: [b] })
    expect(onStaging.decision).toBe('allow')
    expect(contentOf(onStaging).expectedState.executionRoles).toEqual({ owner: OWNER })
    expect(await w.apply(onStaging)).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    expect(await tableOwner(staging, 'er_items')).toBe(OWNER)

    const onProduction = await w.plan(production, { migrationIds: [first as never] })
    expect(failed(onProduction)).toEqual([])
    const c = contentOf(onProduction)
    expect(c.facts.evidence).toBe('present')
    expect(c.expectedState.executionRoles).toEqual({ owner: PROD_OWNER })
    expect(c.migrations.map((m) => m.executionRole)).toEqual([PROD_OWNER])
    // Both owners are plain NOLOGIN roles without an exception: parity holds.
    expect(c.facts.executionRoleParity).toBe('match')
    expect(failed(onProduction)).not.toContain('migration.execution-role-parity')
    expect(await w.apply(onProduction)).toMatchObject({
      state: 'succeeded',
      verificationOutcome: 'passed',
    })
    expect(await tableOwner(production, 'er_items')).toBe(PROD_OWNER)
  })

  it('makes a plan stale when a binding changes after planning or after acceptance', async () => {
    const b = w.bundle({
      name: 'labels',
      up: 'CREATE TABLE public.er_labels (id int);\n',
      dependsOn: [first],
    })
    const before = await w.plan(staging, { bundles: [b] })
    await bind(staging, { owner: PROD_OWNER })
    await expect(w.accept(before)).rejects.toMatchObject({ code: 'PLAN_STALE' })

    // Accepted under PROD_OWNER, then the binding changes before the worker starts it.
    const accepted = await w.accept(
      await w.plan(staging, { migrationIds: [b.directory.slice(0, 26) as never] }),
    )
    await bind(staging, {})
    await w.drive()
    const op = await w.operation(accepted.operationId)
    expect(op).toMatchObject({ state: 'failed', applyOutcome: 'not_started' })
    expect((await operationError(w.h, op.operationId)).code).toBe('PLAN_STALE')
    expect(await tableOwner(staging, 'er_labels')).toBeUndefined()

    // Nothing is deleted: the staging binding ended and its history stays.
    const history = await w.h.worker.query(
      'test.er.history',
      `SELECT role, ended_at IS NOT NULL AS ended FROM registry.execution_role_bindings
        WHERE environment_id = $1 ORDER BY set_at`,
      [staging.record.environmentId],
    )
    expect(history.rows.map((r) => [r.text('role'), r.bool('ended')])).toEqual([[PROD_OWNER, true]])
  })

  it('refuses an alias outside the project map and a protected role', async () => {
    await expect(bind(staging, { reader: PROD_OWNER })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
    await expect(bind(staging, { owner: 'exponetdb_migrator' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })
})

describe('a declared BYPASSRLS exception (ADR-0034 §1 to §3)', () => {
  let exceptionId = ''
  let base = ''

  it('refuses an owner with BYPASSRLS until a person declares the exception', async () => {
    await bind(staging, { owner: DEFINER })
    const b = w.bundle({
      name: 'definer',
      ...table('er_definer'),
      down: 'DROP TABLE public.er_definer;\n',
    })
    base = b.directory.slice(0, 26)
    const refused = await w.plan(staging, { bundles: [b] })
    expect(refused.decision).toBe('deny')
    expect(contentOf(refused).facts.requirementsUnmet).toContain('execution_role')

    exceptionId = await declare(staging, DEFINER)
    const p = await w.plan(staging, { migrationIds: [base as never] })
    expect(p.decision).not.toBe('deny')
    const c = contentOf(p)
    expect(c.expectedState.executionRoleExceptions).toEqual({
      [DEFINER]: { exceptionId, revision: 1 },
    })
    expect(c.facts.executionRoleExceptions).toBe(1)
    expect(failed(p)).toContain('migration.execution-role-exception')
    const shown = (p.body['analysis'] as { executionRoleExceptions: { role: string }[] })
      .executionRoleExceptions
    expect(shown).toMatchObject([{ role: DEFINER, exceptionId, revision: 1 }])
    expect(await w.apply(p)).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect(await tableOwner(staging, 'er_definer')).toBe(DEFINER)
  })

  it('never excuses another privileged attribute', async () => {
    await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${DEFINER} CREATEDB`])
    try {
      const b = w.bundle({
        name: 'createdb',
        up: 'CREATE TABLE public.er_createdb (id int);\n',
        dependsOn: [base],
      })
      const p = await w.plan(staging, { bundles: [b] })
      expect(p.decision).toBe('deny')
      expect(contentOf(p).facts.requirementsUnmet).toContain('execution_role')
    } finally {
      await runAsSuperuser(pg17, 'postgres', [`ALTER ROLE ${DEFINER} NOCREATEDB`])
    }
  })

  it('lets an agent apply on nonprod under the exception', async () => {
    const b = w.bundle({
      name: 'agent',
      up: 'CREATE TABLE public.er_agent (id int);\n',
      dependsOn: [base],
    })
    const p = await planAs(agent(), staging, { bundles: [b] })
    expect(p.decision).not.toBe('deny')
    expect(contentOf(p).facts.executionRoleExceptions).toBe(1)
    expect(failed(p)).not.toContain('migration.agent-production')
  })

  it('makes a plan stale once the exception is revoked, and refuses the next plan', async () => {
    const b = w.bundle({
      name: 'revoked',
      up: 'CREATE TABLE public.er_revoked (id int);\n',
      dependsOn: [base],
    })
    const p = await w.plan(staging, { bundles: [b] })
    await revoke(staging, exceptionId)
    await expect(w.accept(p)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    const again = await w.plan(staging, { migrationIds: [b.directory.slice(0, 26) as never] })
    expect(again.decision).toBe('deny')
    // A revoked declaration is never revoked twice.
    await expect(revokePlan(staging, exceptionId)).rejects.toMatchObject({
      code: 'REGISTRY_CONFLICT',
      details: { reason: 'exception_not_active' },
    })
  })

  it('checks the rollback execution role like an apply', async () => {
    // Revoked: the rollback of the definer migration would run as a BYPASSRLS role.
    const refused = await w.h.serve.transaction('test.er.rollback', (tx) =>
      planMigrationRollback(tx, w.ctx, w.a, staging.record.targetId, base),
    )
    expect(refused.decision).toBe('deny')

    const renewed = await declare(staging, DEFINER)
    const p = await w.h.serve.transaction('test.er.rollback', (tx) =>
      planMigrationRollback(tx, w.ctx, w.a, staging.record.targetId, base),
    )
    expect(p.decision).toBe('allow')
    expect(contentOf(p).expectedState.executionRoleExceptions).toEqual({
      [DEFINER]: { exceptionId: renewed, revision: 1 },
    })
    await revoke(staging, renewed)
    await expect(w.accept(p)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    expect(await tableOwner(staging, 'er_definer')).toBe(DEFINER)
    exceptionId = await declare(staging, DEFINER)
  })

  it('production: the declaration waits for an approval, parity is checked, the plan waits for a person', async () => {
    const declaring = await registryPlan(w.h, (tx) =>
      planExecutionRoleExceptionDeclare(
        tx,
        w.h.context,
        w.a,
        production.record.projectId,
        production.record.environmentId,
        { role: DEFINER, reason: 'Definer functions of the adopted schema read FORCE tables.' },
      ),
    )
    expect(declaring.decision).toBe('require')
    const requirements = (declaring.body['policy'] as { requirements: { kind: string }[] })
      .requirements
    expect(requirements.map((r) => r.kind).sort()).toEqual(['approval', 'reauth'])
    // Not declared on production yet: refused, and its owner differs from staging's in exception status.
    await bind(production, { owner: DEFINER })
    const mismatch = await w.plan(production, { migrationIds: [base as never] })
    expect(mismatch.decision).toBe('deny')
    expect(contentOf(mismatch).facts.executionRoleParity).toBe('mismatch')

    const prodException = await declare(production, DEFINER)
    const human = await w.plan(production, { migrationIds: [base as never] })
    expect(contentOf(human).facts).toMatchObject({
      evidence: 'present',
      executionRoleExceptions: 1,
      executionRoleParity: 'match',
    })
    expect(contentOf(human).expectedState.executionRoleExceptions).toEqual({
      [DEFINER]: { exceptionId: prodException, revision: 1 },
    })
    // fp1 includes owners: production's er_items (PROD_OWNER) and staging's (the world's
    // owner) differ, so the lineage rule asks a person (fail closed; OD-53), and the
    // exception is shown. Nothing here is denied.
    expect(human.decision).toBe('require')
    expect(failed(human).sort()).toEqual([
      'migration.execution-role-exception',
      'migration.fingerprint-lineage',
    ])
    expect(contentOf(human).facts).toMatchObject({ lineage: 'mismatch' })
    const byAgent = await planAs(agent(), production, { migrationIds: [base as never] })
    expect(byAgent.decision).toBe('require')
    expect(failed(byAgent)).toContain('migration.agent-production')
    const queued = await w.accept(human)
    expect(queued.state).toBe('awaiting_approval')
  })
})

/** The independent review of A4 and A5 (Part A record §6): each finding as a regression test. */
describe('execution roles: review findings', () => {
  const sqlstate = (e: unknown) => (e as { code?: string }).code
  let qaEnvironment = ''

  it('refuses an owner that reaches a privileged role, a declaration notwithstanding (P2-1)', async () => {
    await runAsSuperuser(pg17, 'postgres', [`CREATE ROLE ${REACHED} NOLOGIN BYPASSRLS`])
    await prepareRole(PROBE, '', [staging])
    await runAsSuperuser(pg17, 'postgres', [`GRANT ${REACHED} TO ${PROBE}`])
    await bind(staging, { owner: PROBE })
    const b = w.bundle({ name: 'reach', up: 'CREATE TABLE public.er_reach (id int);\n' })
    const refused = await w.plan(staging, { bundles: [b] })
    expect(refused.decision).toBe('deny')
    expect(contentOf(refused).facts.requirementsUnmet).toContain('execution_role')
    const declared = await declare(staging, PROBE)
    const still = await w.plan(staging, { migrationIds: [b.directory.slice(0, 26) as never] })
    expect(still.decision).toBe('deny')
    await revoke(staging, declared)
    await bind(staging, { owner: DEFINER })
  })

  it('stops a running plan before its next migration once its declaration is revoked (P3-1)', async () => {
    const live = (await executionRolesFor(w.h.worker, staging.record)).exceptions.get(DEFINER)
    if (live === undefined) throw new Error('the definer exception is active')
    const first = w.ulid()
    const second = w.ulid()
    const p = await w.plan(staging, {
      bundles: [
        w.bundle({ id: first, name: 'first', up: 'CREATE TABLE public.er_first (id int);\n' }),
        w.bundle({
          id: second,
          name: 'second',
          up: 'CREATE TABLE public.er_second (id int);\n',
          dependsOn: [first],
        }),
      ],
    })
    let calls = 0
    // Admitted at dispatch and at the start; the declaration is revoked before the second.
    const admit: DispatchAdmission = async () => {
      calls += 1
      if (calls === 3) await revoke(staging, live.exceptionId)
      return []
    }
    const op = await w.apply(p, { admit })
    expect(op).toMatchObject({ applyOutcome: 'partially_applied' })
    const progress = await readProgress(w.h.worker, op.operationId)
    expect(progress.map((x) => [x.applyOutcome, x.errorCode])).toEqual([
      ['applied', null],
      ['not_started', 'PLAN_STALE'],
    ])
    expect(await tableOwner(staging, 'er_first')).toBe(DEFINER)
    expect(await tableOwner(staging, 'er_second')).toBeUndefined()
    await declare(staging, DEFINER)
  })

  it('excuses nothing after the review date: the waiting plan goes stale and the next is denied', async () => {
    const live = (await executionRolesFor(w.h.worker, staging.record)).exceptions.get(DEFINER)
    if (live === undefined) throw new Error('the definer exception is active')
    const b = w.bundle({ name: 'review', up: 'CREATE TABLE public.er_review (id int);\n' })
    const p = await w.plan(staging, { bundles: [b] })
    expect(p.decision).not.toBe('deny')
    // The date passes (the guard keeps review_by fixed, so the clock is moved for the row).
    await w.h.db.asSuperuser(async (c) => {
      await c.query(
        'ALTER TABLE registry.execution_role_exceptions DISABLE TRIGGER execution_role_exceptions_guard',
      )
      await c.query(
        `UPDATE registry.execution_role_exceptions SET review_by = current_date - 1 WHERE exception_id = $1`,
        [live.exceptionId],
      )
      await c.query(
        'ALTER TABLE registry.execution_role_exceptions ENABLE TRIGGER execution_role_exceptions_guard',
      )
    })
    await expect(w.accept(p)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    const next = await w.plan(staging, { migrationIds: [b.directory.slice(0, 26) as never] })
    expect(next.decision).toBe('deny')
    const view = await projectExecutionRoles(w.h.serve, staging.record.projectId)
    expect(view.exceptions.find((e) => e.id === live.exceptionId)).toMatchObject({
      state: 'active',
      expired: true,
    })
    await revoke(staging, live.exceptionId)
    await declare(staging, DEFINER)
  })

  it('audits every declaration and revocation', async () => {
    const { rows } = await w.h.worker.query(
      'test.er.audit',
      `SELECT action, (event::jsonb)->'changes'->>'exceptionId' AS exception,
              (event::jsonb)->'changes'->>'role' AS role
         FROM audit.audit_events
        WHERE action IN ('registry.execution_role_exception.declare',
                         'registry.execution_role_exception.revoke',
                         'registry.execution_role_binding.set')`,
    )
    const actions = rows.map((r) => r.text('action'))
    expect(actions.filter((a) => a.endsWith('.declare')).length).toBeGreaterThanOrEqual(5)
    expect(actions.filter((a) => a.endsWith('.revoke')).length).toBeGreaterThanOrEqual(4)
    expect(actions.filter((a) => a.endsWith('.set')).length).toBeGreaterThanOrEqual(5)
    for (const r of rows) {
      if (r.text('action').endsWith('.declare')) {
        expect(r.textOrNull('exception')).toMatch(/^rxe_/)
        expect([DEFINER, PROBE]).toContain(r.textOrNull('role'))
      }
    }
  })

  it('guards the records in the Control Store (EXG13, EXG14) and the worker never deletes one', async () => {
    const live = (await executionRolesFor(w.h.worker, staging.record)).exceptions.get(DEFINER)
    if (live === undefined) throw new Error('the definer exception is active')
    await w.h.db.asRole('exdb_worker', async (c) => {
      for (const statement of [
        `DELETE FROM registry.execution_role_exceptions WHERE exception_id = '${live.exceptionId}'`,
        `DELETE FROM registry.execution_role_bindings WHERE environment_id = '${staging.record.environmentId}'`,
        `UPDATE registry.execution_role_exceptions SET attributes = ARRAY['bypassrls','superuser'] WHERE exception_id = '${live.exceptionId}'`,
        `UPDATE registry.execution_role_bindings SET role = 'acme_other' WHERE environment_id = '${staging.record.environmentId}'`,
      ]) {
        expect(sqlstate(await c.query(statement).catch((e: unknown) => e)), statement).toBe('42501')
      }
    })
    await w.h.db.asSuperuser(async (c) => {
      const refused = async (statement: string, params: unknown[] = []) =>
        sqlstate(await c.query(statement, params).catch((e: unknown) => e))
      expect(
        await refused('DELETE FROM registry.execution_role_exceptions WHERE exception_id = $1', [
          live.exceptionId,
        ]),
      ).toBe('EXG14')
      // A revoked declaration is never active again.
      const revokedId = (
        await c.query(
          `SELECT exception_id FROM registry.execution_role_exceptions WHERE state = 'revoked' LIMIT 1`,
        )
      ).rows[0]?.exception_id as string
      expect(
        await refused(
          `UPDATE registry.execution_role_exceptions SET state = 'active', revision = revision + 1
            WHERE exception_id = $1`,
          [revokedId],
        ),
      ).toBe('EXG14')
      // Nothing but BYPASSRLS is ever stored, whoever writes.
      expect(
        await refused(
          `UPDATE registry.execution_role_exceptions SET attributes = ARRAY['bypassrls','superuser']
            WHERE exception_id = $1`,
          [live.exceptionId],
        ),
      ).toMatch(/^(EXG14|23514)$/)
      // A declaration needs its own operation kind.
      const otherOp = (
        await c.query(
          `SELECT operation_id FROM operations.operations WHERE kind = 'registry.execution_role_binding.set' LIMIT 1`,
        )
      ).rows[0]?.operation_id as string
      expect(
        await refused(
          `INSERT INTO registry.execution_role_exceptions
             (exception_id, project_id, environment_id, role_name, attributes, reason, state, revision,
              declared_by, declared_at, declared_by_operation_id)
           VALUES ('rxe_01M5GZZZZZZZZZZZZZZZZZZZZZ', $1, $2, 'acme_x', ARRAY['bypassrls'],
                   'a reason long enough to pass', 'active', 1, $3, now(), $4)`,
          [staging.record.projectId, staging.record.environmentId, w.a.identityId, otherOp],
        ),
      ).toBe('EXG14')
      // An ended binding never changes again, and none is deleted.
      const ended = (
        await c.query(
          `SELECT alias, set_by_operation_id FROM registry.execution_role_bindings
            WHERE environment_id = $1 AND ended_at IS NOT NULL LIMIT 1`,
          [staging.record.environmentId],
        )
      ).rows[0] as { alias: string; set_by_operation_id: string }
      expect(
        await refused(
          `UPDATE registry.execution_role_bindings SET ended_at = NULL, ended_by_operation_id = NULL
            WHERE environment_id = $1 AND alias = $2 AND set_by_operation_id = $3`,
          [staging.record.environmentId, ended.alias, ended.set_by_operation_id],
        ),
      ).toBe('EXG13')
      expect(
        await refused('DELETE FROM registry.execution_role_bindings WHERE environment_id = $1', [
          staging.record.environmentId,
        ]),
      ).toBe('EXG13')
    })
  })

  it("keeps an environment's tier while it binds roles, and binds nothing for an alias the map lost", async () => {
    const env = await run(w.h, w.a, (tx) =>
      planEnvironmentCreate(tx, w.h.context, w.a, staging.record.productId, {
        slug: 'qa',
        displayName: 'QA',
        tier: 'nonprod',
      }),
    )
    qaEnvironment = String((await planContent(w.h, env.plan.planId))['environmentId'])
    const qa = { record: { ...staging.record, environmentId: qaEnvironment }, database: '' }
    await run(w.h, w.a, (tx) =>
      planProjectUpdate(tx, w.h.context, w.a, staging.record.projectId, {
        executionRoles: { owner: OWNER, extra: APP },
      }),
    )
    await bind(qa as Target, { extra: PROD_OWNER })
    await expect(
      registryPlan(w.h, (tx) =>
        planEnvironmentUpdate(tx, w.h.context, w.a, staging.record.productId, qaEnvironment, {
          tier: 'prod',
        }),
      ),
    ).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', details: { reason: 'tier_in_use' } })
    await w.h.db.asSuperuser(async (c) => {
      const e = await c
        .query(`UPDATE registry.environments SET tier = 'prod' WHERE environment_id = $1`, [
          qaEnvironment,
        ])
        .catch((x: unknown) => x)
      expect(sqlstate(e)).toBe('EXG14')
    })
    // The map drops the alias: the environment's binding of it binds nothing.
    await run(w.h, w.a, (tx) =>
      planProjectUpdate(tx, w.h.context, w.a, staging.record.projectId, {
        executionRoles: { owner: OWNER },
      }),
    )
    const resolved = await executionRolesFor(w.h.worker, {
      projectId: staging.record.projectId,
      environmentId: qaEnvironment,
    })
    expect(resolved.roles).toEqual({ owner: OWNER })
    const view = await projectExecutionRoles(w.h.serve, staging.record.projectId)
    expect(view.environments.find((e) => e.environmentId === qaEnvironment)).toMatchObject({
      bindings: { extra: PROD_OWNER },
      effective: { owner: OWNER },
    })
  })
})
