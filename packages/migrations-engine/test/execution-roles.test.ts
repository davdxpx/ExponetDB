import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionRoleFacts } from '@exponetdb/postgres'
import { blocksExecution, executionRoleProblem } from '@exponetdb/postgres'
import type { ExecutionRoleExceptionRecord } from '@exponetdb/registry'
import { describe, expect, it } from 'vitest'
import {
  boundExceptionsHold,
  excusedFor,
  rolesStillUsable,
  roleUnder,
} from '../src/execution-roles.ts'

/**
 * Execution roles for adopted schemas (ADR-0034), without a database: the
 * only excusable attribute is BYPASSRLS, only as a role's sole problem;
 * bound exceptions must hold exactly; and no module of the engine but the
 * resolver reads the project map or the registry's bindings and exceptions.
 */
const SRC = new URL('../src/', import.meta.url).pathname

const OWNER: ExecutionRoleFacts = {
  role: 'staging_owner',
  exists: true,
  canLogin: false,
  superuser: false,
  createRole: false,
  createDb: false,
  replication: false,
  bypassRls: true,
  reachesProtected: false,
  membership: { set: true, inherit: false },
}

function exception(over: Partial<ExecutionRoleExceptionRecord> = {}): ExecutionRoleExceptionRecord {
  return {
    exceptionId: 'rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
    projectId: 'prj_01M5G6EQ7KP3PMPC7G3HJ7KH7S',
    environmentId: 'env_01M5G6EQ7KP3PMPC7G3HJ7KH7T',
    role: 'staging_owner',
    reason: 'Supabase-origin definer functions on FORCE tables need it.',
    reviewBy: null,
    state: 'active',
    expired: false,
    revision: 1,
    declaredBy: 'idn_01M5G6EQ7KP3PMPC7G3HJ7KH7V',
    declaredAt: '2026-10-21T00:00:00.000Z',
    revokedBy: null,
    revokedAt: null,
    revokeReason: null,
    ...over,
  }
}

describe('the declared BYPASSRLS exception', () => {
  it('excuses BYPASSRLS as the sole problem of the role it names, and only that role', () => {
    const exceptions = new Map([['staging_owner', exception()]])
    expect(executionRoleProblem(OWNER)).toBe('privileged_attribute')
    expect(roleUnder(OWNER, exceptions)).toEqual({
      problem: 'declared_exception',
      binding: { exceptionId: 'rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7R', revision: 1 },
    })
    expect(blocksExecution('declared_exception')).toBe(false)
    // Another role, the same attributes: nothing excused.
    expect(roleUnder({ ...OWNER, role: 'other_owner' }, exceptions).problem).toBe(
      'privileged_attribute',
    )
    // Without BYPASSRLS the role needs no exception and binds none.
    expect(roleUnder({ ...OWNER, bypassRls: false }, exceptions)).toEqual({
      problem: null,
      binding: null,
    })
  })

  it('never excuses SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, LOGIN, protected reach or a membership defect', () => {
    const bypass = new Set(['bypassrls'] as const)
    const cases: [Partial<ExecutionRoleFacts>, string][] = [
      [{ superuser: true }, 'privileged_attribute'],
      [{ createRole: true }, 'privileged_attribute'],
      [{ createDb: true }, 'privileged_attribute'],
      [{ replication: true }, 'privileged_attribute'],
      [{ canLogin: true }, 'can_login'],
      [{ reachesProtected: true }, 'reaches_protected_role'],
      [{ membership: null }, 'not_a_member'],
      [{ membership: { set: false, inherit: false } }, 'membership_without_set'],
      [{ membership: { set: true, inherit: true } }, 'membership_inherits'],
      [{ exists: false }, 'missing'],
      [{ role: 'pg_read_all_data' }, 'predefined_role'],
      [{ role: 'exponetdb_migrator' }, 'exponetdb_role'],
    ]
    for (const [over, problem] of cases) {
      expect(executionRoleProblem({ ...OWNER, ...over }, bypass), JSON.stringify(over)).toBe(
        problem,
      )
      expect(blocksExecution(problem as never)).toBe(true)
    }
    expect(excusedFor('staging_owner', new Map([['staging_owner', 1]]))).toEqual(bypass)
    expect([...excusedFor('other', new Map([['staging_owner', 1]]))]).toEqual([])
  })

  it('holds a bound exception only with the same id and revision, still effective', () => {
    const bound = { staging_owner: { exceptionId: 'rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7R', revision: 1 } }
    expect(boundExceptionsHold(bound, new Map([['staging_owner', exception()]]))).toBe(true)
    expect(boundExceptionsHold(undefined, new Map())).toBe(true)
    // Revoked or expired: no longer among the effective exceptions.
    expect(boundExceptionsHold(bound, new Map())).toBe(false)
    expect(
      boundExceptionsHold(bound, new Map([['staging_owner', exception({ revision: 2 })]])),
    ).toBe(false)
    expect(
      boundExceptionsHold(
        bound,
        new Map([['staging_owner', exception({ exceptionId: 'rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7Z' })]]),
      ),
    ).toBe(false)
  })

  it('under the lock excuses BYPASSRLS only for the roles the plan bound', () => {
    const bound = { staging_owner: { exceptionId: 'rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7R', revision: 1 } }
    expect(rolesStillUsable([OWNER], bound)).toBe(true)
    expect(rolesStillUsable([OWNER], undefined)).toBe(false)
    expect(rolesStillUsable([{ ...OWNER, role: 'other_owner' }], bound)).toBe(false)
    expect(rolesStillUsable([{ ...OWNER, createRole: true }], bound)).toBe(false)
    expect(rolesStillUsable([{ ...OWNER, bypassRls: false }], undefined)).toBe(true)
  })
})

describe('one resolver', () => {
  it('no module of the engine but execution-roles.ts reads the project map, the bindings or the exceptions', async () => {
    const forbidden = [
      /json\(\s*'execution_roles'\s*\)/,
      /\b[a-z]\.execution_roles\b/,
      /SELECT[^`]*\bexecution_roles\b/s,
      /execution_role_(bindings|exceptions)\b/,
      /\b(projectDefaultRoles|environmentRoleBindings|effectiveExceptions)\b/,
    ]
    const offenders: string[] = []
    for (const name of await readdir(SRC)) {
      if (!name.endsWith('.ts') || name === 'execution-roles.ts') continue
      const text = await readFile(join(SRC, name), 'utf8')
      for (const pattern of forbidden) if (pattern.test(text)) offenders.push(`${name}: ${pattern}`)
    }
    expect(offenders).toEqual([])
  })
})
