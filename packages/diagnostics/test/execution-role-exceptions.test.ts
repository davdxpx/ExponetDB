import type { ExecutionRoleFacts } from '@exponetdb/postgres'
import type { ExecutionRoleExceptionRecord } from '@exponetdb/registry'
import { describe, expect, it } from 'vitest'
import {
  exceptionDrift,
  exceptionDriftDetails,
  exceptionFindingKey,
} from '../src/execution-role-exceptions.ts'

const declaration = (over: Partial<ExecutionRoleExceptionRecord> = {}) =>
  ({
    exceptionId: 'rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
    projectId: 'prj_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
    environmentId: 'env_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
    role: 'acme_owner',
    reason: 'Definer functions read FORCE tables.',
    reviewBy: null,
    state: 'active',
    expired: false,
    revision: 1,
    declaredBy: 'idn_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
    declaredAt: '2026-10-21T09:00:00.000Z',
    revokedBy: null,
    revokedAt: null,
    revokeReason: null,
    ...over,
  }) satisfies ExecutionRoleExceptionRecord

const role = (over: Partial<ExecutionRoleFacts> = {}): ExecutionRoleFacts => ({
  role: 'acme_owner',
  exists: true,
  canLogin: false,
  superuser: false,
  createRole: false,
  createDb: false,
  replication: false,
  bypassRls: true,
  reachesProtected: false,
  membership: { set: true, inherit: false },
  ...over,
})

describe('execution-role exception drift (ADR-0034 §4)', () => {
  it('raises nothing while the role matches its declaration', () => {
    expect(exceptionDrift(declaration(), role())).toBeNull()
  })

  it('is critical when the role gains any attribute no exception excuses', () => {
    for (const attribute of ['superuser', 'createRole', 'createDb', 'replication'] as const) {
      expect(exceptionDrift(declaration(), role({ [attribute]: true }))).toMatchObject({
        reason: 'privilege_exceeded',
        severity: 'critical',
      })
      // Also without BYPASSRLS and past the review date: the gain wins.
      expect(
        exceptionDrift(
          declaration({ expired: true }),
          role({ [attribute]: true, bypassRls: false }),
        ),
      ).toMatchObject({ reason: 'privilege_exceeded', severity: 'critical' })
    }
  })

  it('warns when the declaration is stale, gone or past its review date', () => {
    expect(exceptionDrift(declaration(), role({ bypassRls: false }))).toMatchObject({
      reason: 'bypassrls_lost',
      severity: 'warning',
    })
    expect(exceptionDrift(declaration(), role({ exists: false, bypassRls: false }))).toMatchObject({
      reason: 'role_missing',
      severity: 'warning',
    })
    expect(exceptionDrift(declaration(), undefined)).toMatchObject({ reason: 'role_missing' })
    expect(exceptionDrift(declaration({ expired: true }), role())).toMatchObject({
      reason: 'review_passed',
      severity: 'warning',
    })
  })

  it('keys one finding per declaration and keeps values out of its details', () => {
    const d = exceptionDrift(declaration(), role({ bypassRls: false }))
    expect(d).not.toBeNull()
    if (d === null) return
    expect(exceptionFindingKey(d.exceptionId)).toBe(
      'health:execution_role_exception:rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
    )
    expect(exceptionDriftDetails(d)).toEqual({
      exceptionId: 'rxe_01M5G6EQ7KP3PMPC7G3HJ7KH7R',
      role: 'acme_owner',
      reason: 'bypassrls_lost',
      securityRelevant: true,
      object: null,
    })
  })
})
