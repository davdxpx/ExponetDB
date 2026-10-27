import { TargetError } from '@exponetdb/postgres'
import { describe, expect, it } from 'vitest'
import {
  bypassrlsLoginRole,
  driftOpen,
  duplicateIndex,
  extensionInPublic,
  inactiveReplicationSlot,
  multiplePermissivePolicies,
  plaintextClientConnections,
  rlsDisabledWithGrants,
  rlsEnabledWithoutPolicy,
  securityDefinerWithoutSearchPath,
  settingsPendingRestart,
  stagingBehindProduction,
  tableWithoutPrimaryKey,
  unindexedForeignKey,
  unusedIndex,
  walArchiveFailing,
  xidAgeHigh,
} from '../src/advisors/catalog.ts'
import {
  ADVISOR_RULES,
  advisorDedupKey,
  apiReason,
  type SessionFacts,
  sessionBindings,
  skipReasonOf,
  XID_CRITICAL_AGE,
} from '../src/index.ts'

/** Each advisor rule's evaluate on its facts (performance.md §4), and the session bindings of §5. */
const env = { nowMs: Date.parse('2026-10-27T00:00:00Z') }
const HOSTILE = 'x"; DROP TABLE y; --'

describe('the advisor catalog', () => {
  it('has unique rule ids in the four categories', () => {
    const ids = ADVISOR_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(17)
    for (const r of ADVISOR_RULES) {
      expect(['security', 'performance', 'operations', 'change_safety']).toContain(r.category)
      expect(r.id).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
    }
  })

  it('names objects with quoted untrusted names and bounded evidence', () => {
    const [f] = rlsDisabledWithGrants.evaluate(
      [{ schema: 'public', name: HOSTILE, privileges: 'SELECT', grantees: 1, toPublic: true }],
      env,
    )
    expect(f?.object).toBe('table public."x""; DROP TABLE y; --"')
    expect(f).toMatchObject({ level: 'warning', category: 'security', draft: 'none' })
    expect(f?.evidence).toEqual({ privileges: 'SELECT', grantees: 1, toPublic: true })
    expect(advisorDedupKey({ rule: 'r', object: null })).toBe('r:*')
  })

  it('evaluates the security rules', () => {
    expect(
      rlsEnabledWithoutPolicy.evaluate([{ schema: 's', name: 't', forced: false }], env)[0],
    ).toMatchObject({ rule: 'rls_enabled_without_policy', level: 'info', object: 'table s.t' })
    expect(
      securityDefinerWithoutSearchPath.evaluate(
        [{ schema: 's', name: 'f', args: 'integer' }],
        env,
      )[0],
    ).toMatchObject({ object: 'function s.f(integer)', draft: 'migration_draft' })
    expect(bypassrlsLoginRole.evaluate([{ name: 'App' }], env)[0]?.object).toBe('role "App"')
    expect(extensionInPublic.evaluate([{ name: 'pgcrypto', version: '1.3' }], env)[0]?.object).toBe(
      'extension pgcrypto',
    )
    expect(plaintextClientConnections.evaluate({ remote: 0, loopback: 0 }, env)).toEqual([])
    expect(plaintextClientConnections.evaluate({ remote: 0, loopback: 2 }, env)[0]?.level).toBe(
      'info',
    )
    expect(plaintextClientConnections.evaluate({ remote: 1, loopback: 0 }, env)[0]).toMatchObject({
      level: 'warning',
      object: null,
      evidence: { remote: 1, loopback: 0 },
    })
  })

  it('evaluates the performance rules', () => {
    expect(
      unindexedForeignKey.evaluate(
        [{ schema: 's', name: 't', constraint: 't_a_fkey', columns: 'a, b' }],
        env,
      )[0],
    ).toMatchObject({ object: 'constraint t_a_fkey on s.t', draft: 'migration_draft' })
    expect(
      duplicateIndex.evaluate(
        [
          {
            schema: 's',
            table: 't',
            name: 'i2',
            sizeBytes: 8192,
            duplicateOf: 'i1',
            unique: false,
          },
        ],
        env,
      )[0],
    ).toMatchObject({ object: 'index s.i2', evidence: { duplicateOf: 'i1', unique: false } })
    expect(
      unusedIndex.evaluate(
        {
          statsSince: '2026-10-01T00:00:00.000Z',
          indexes: [{ schema: 's', table: 't', name: 'i', sizeBytes: 1 }],
        },
        env,
      )[0]?.evidence,
    ).toMatchObject({ statsSince: '2026-10-01T00:00:00.000Z' })
    expect(tableWithoutPrimaryKey.evaluate([{ schema: 's', name: 't' }], env)[0]?.level).toBe(
      'info',
    )
    expect(
      multiplePermissivePolicies.evaluate(
        [{ schema: 's', name: 't', role: 'public', command: 'SELECT', policies: 2, names: 'a, b' }],
        env,
      )[0]?.object,
    ).toBe('table s.t role public SELECT')
  })

  it('evaluates the operations rules with their thresholds', () => {
    const xid = (age: number) =>
      xidAgeHigh.evaluate({ database: 'db', age, freezeMaxAge: 200_000_000, oldest: 's.t' }, env)
    expect(xid(299_999_999)).toEqual([])
    expect(xid(300_000_000)[0]?.level).toBe('warning')
    expect(xid(XID_CRITICAL_AGE)[0]?.level).toBe('critical')
    expect(
      inactiveReplicationSlot.evaluate(
        [{ name: 'slot', type: 'logical', database: 'db', retainedBytes: 1024 }],
        env,
      )[0]?.evidence,
    ).toEqual({ type: 'logical', database: 'db', retainedBytes: 1024 })
    const archiver = {
      mode: 'on',
      failedCount: 3,
      lastFailed: '2026-10-26T10:00:00.000000Z',
      lastArchived: '2026-10-26T09:00:00.000000Z',
    }
    expect(walArchiveFailing.evaluate(archiver, env)[0]?.level).toBe('warning')
    expect(
      walArchiveFailing.evaluate({ ...archiver, lastArchived: '2026-10-26T11:00:00.000000Z' }, env),
      'archiving recovered',
    ).toEqual([])
    expect(walArchiveFailing.evaluate({ ...archiver, mode: 'off' }, env)).toEqual([])
    expect(settingsPendingRestart.evaluate([{ name: 'shared_buffers' }], env)[0]?.object).toBe(
      'setting shared_buffers',
    )
  })

  it('evaluates the change-safety rules', () => {
    expect(driftOpen.evaluate({ open: 0, critical: 0 }, env)).toEqual([])
    expect(driftOpen.evaluate({ open: 3, critical: 1 }, env)[0]?.level).toBe('critical')
    expect(driftOpen.evaluate({ open: 3, critical: 0 }, env)[0]?.level).toBe('warning')
    const behind = { applicable: true, evidencePath: 'p/x/staging', missing: 2, examples: 'a, b' }
    expect(stagingBehindProduction.evaluate(behind, env)[0]?.evidence).toEqual({
      missing: 2,
      examples: 'a, b',
    })
    expect(stagingBehindProduction.evaluate({ ...behind, missing: 0 }, env)).toEqual([])
    expect(stagingBehindProduction.evaluate({ ...behind, applicable: false }, env)).toEqual([])
  })

  it('maps a failed read to a skip reason (never a pass)', () => {
    expect(
      skipReasonOf(new TargetError('TARGET_SQL_ERROR', 'protocol', { sqlstate: '57014' })),
    ).toBe('timeout')
    expect(
      skipReasonOf(new TargetError('TARGET_SQL_ERROR', 'protocol', { sqlstate: '42501' })),
    ).toBe('not_permitted')
    expect(skipReasonOf(new Error('x'))).toBe('error')
    expect(apiReason('stats_window_short')).toBe('error')
    expect(apiReason('timeout')).toBe('timeout')
  })
})

describe('session bindings of cancel and terminate', () => {
  const facts: SessionFacts = {
    found: true,
    backendStart: '2026-10-27T09:00:00.000Z',
    queryStart: '2026-10-27T09:59:00.000Z',
    state: 'active',
    backendType: 'client backend',
    role: 'app',
    applicationName: 'app',
    here: true,
    protected: null,
    conditions: { stalled: true, idle_in_transaction: false, long_running: false, any: true },
  }
  const bound = { pid: 42, backendStart: '2026-10-27T09:00:00.000Z' }

  it('hold for the same backend, query and condition', () => {
    expect(sessionBindings({ ...bound, queryStart: '2026-10-27T09:59:00.000Z' }, facts)).toEqual([])
    expect(sessionBindings({ ...bound, condition: 'stalled' }, facts)).toEqual([])
  })

  it('are stale for a reused pid, another query, an idle session or a condition gone', () => {
    expect(
      sessionBindings({ ...bound, backendStart: '2026-10-27T08:00:00.000Z' }, facts)[0]?.binding,
    ).toBe('session')
    expect(sessionBindings(bound, { ...facts, found: false })[0]?.binding).toBe('session')
    expect(sessionBindings(bound, { ...facts, here: false })[0]?.binding).toBe('session')
    expect(
      sessionBindings({ ...bound, queryStart: '2026-10-27T09:58:00.000Z' }, facts)[0]?.binding,
    ).toBe('query')
    expect(
      sessionBindings(
        { ...bound, queryStart: '2026-10-27T09:59:00.000Z' },
        { ...facts, state: 'idle' },
      )[0]?.binding,
    ).toBe('query')
    expect(sessionBindings({ ...bound, condition: 'idle_in_transaction' }, facts)[0]?.binding).toBe(
      'condition',
    )
    expect(sessionBindings(bound, { ...facts, protected: 'backup_session' })[0]).toEqual({
      binding: 'session',
      actual: 'backup_session',
    })
  })
})
