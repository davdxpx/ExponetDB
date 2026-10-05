import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ControlStoreRole, toControlStoreError } from '../src/index.ts'
import { type MigratedTestDatabase, migratedTestDatabase } from '../src/testing/index.ts'

/** The policy-settings bundle against PostgreSQL 17: revisions, writers, immutability. */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_policy')
})

afterAll(async () => {
  await db?.drop()
})

async function sqlstate(
  role: ControlStoreRole,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  try {
    await db.store(role).query('test.statement', sql, params)
    return undefined
  } catch (error) {
    return toControlStoreError(error).sqlstate ?? 'unknown'
  }
}

const insert = `INSERT INTO policy.rule_settings (scope_kind, scope_id, rule_id, revision, params, created_by)
                VALUES ($1, $2, 'migration.agent-production', $3, '{"approvals": 1}', 'someone-else')`

describe('policy.rule_settings', () => {
  it('appends revisions in order; the database records the writer', async () => {
    expect(
      await sqlstate('exdb_worker', insert, ['installation', 'installation', 1]),
    ).toBeUndefined()
    expect(await sqlstate('exdb_worker', insert, ['installation', 'installation', 3])).toBe('EXP01')
    expect(await sqlstate('exdb_worker', insert, ['installation', 'installation', 1])).toBe('EXP01')
    expect(
      await sqlstate('exdb_worker', insert, ['installation', 'installation', 2]),
    ).toBeUndefined()
    const { rows } = await db
      .store('exdb_serve')
      .query(
        'test.policy.rows',
        'SELECT revision, created_by FROM policy.rule_settings ORDER BY revision',
      )
    expect(rows.map((r) => [r.int('revision'), r.text('created_by')])).toEqual([
      [1, 'exdb_worker'],
      [2, 'exdb_worker'],
    ])
  })

  it('checks the scope id against the scope kind', async () => {
    expect(
      await sqlstate('exdb_worker', insert, ['installation', 'prj_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', 1]),
    ).toBe('23514')
    expect(
      await sqlstate('exdb_worker', insert, ['project', 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', 1]),
    ).toBe('23514')
    expect(
      await sqlstate('exdb_worker', insert, ['project', 'prj_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', 1]),
    ).toBeUndefined()
  })

  it('only the worker writes; nobody changes or removes a revision', async () => {
    expect(
      await sqlstate('exdb_serve', insert, ['target', 'tgt_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', 1]),
    ).toBe('42501')
    expect(await sqlstate('exdb_gateway', 'SELECT 1 FROM policy.rule_settings')).toBe('42501')
    expect(await sqlstate('exdb_audit_maint', 'SELECT 1 FROM policy.rule_settings')).toBe('42501')
    for (const role of ['exdb_serve', 'exdb_worker'] as const) {
      expect(await sqlstate(role, "UPDATE policy.rule_settings SET params = '{}'")).toBe('42501')
      expect(await sqlstate(role, 'DELETE FROM policy.rule_settings')).toBe('42501')
    }
    expect(await sqlstate('exdb_migrate', "UPDATE policy.rule_settings SET params = '{}'")).toBe(
      'EXA01',
    )
    expect(await sqlstate('exdb_migrate', 'TRUNCATE policy.rule_settings')).toBe('EXA01')
  })
})
