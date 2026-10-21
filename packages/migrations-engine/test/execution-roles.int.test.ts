import type { PlanRecord } from '@exponetdb/operations'
import { RuleRegistry } from '@exponetdb/policy'
import {
  planExecutionRoleBindings,
  planExecutionRoleExceptionDeclare,
  planExecutionRoleExceptionRevoke,
  type RegistryActor,
} from '@exponetdb/registry'
import { runAsSuperuser, serverFor, type TestServer, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { operationError, plan as registryPlan, run } from '../../registry/test/harness.ts'
import { planMigrationApply, planMigrationRollback } from '../src/index.ts'
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
