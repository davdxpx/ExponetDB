import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_ROLE_IDS,
  BUILT_IN_ROLES,
  type BuiltInRoleId,
  isBuiltInRoleId,
  PERMISSION_IDS,
  PERMISSIONS,
  type Permission,
  rolePermissions,
} from '../src/index.ts'
import { readDoc, section, tableRows } from './docs.ts'

const roleSource = readFileSync(new URL('../src/roles.ts', import.meta.url), 'utf8')

describe('built-in role matrix (G3A S17, S18)', () => {
  it('has exactly the six documented V1 roles', () => {
    expect([...BUILT_IN_ROLE_IDS]).toEqual([
      'owner',
      'admin',
      'operator',
      'developer',
      'viewer',
      'auditor',
    ])
    expect(isBuiltInRoleId('owner')).toBe(true)
    expect(isBuiltInRoleId('root')).toBe(false)
    expect(isBuiltInRoleId('*')).toBe(false)
  })

  it('lists only catalog permissions, each once, never a wildcard', () => {
    for (const role of BUILT_IN_ROLE_IDS) {
      const list = rolePermissions(role)
      expect(new Set(list).size, role).toBe(list.length)
      for (const p of list) {
        expect(PERMISSION_IDS, `${role}: ${p}`).toContain(p)
        expect(p, role).toMatch(/^[a-z]+\.[a-z_]+$/)
        expect(p, role).not.toContain('*')
      }
    }
  })

  it('writes every list as literals: nothing is derived from the catalog', () => {
    // A derived list (catalog filter, prefix match, "all") would hand a new
    // permission to an existing role automatically. The source must not even
    // reference the catalog values or a matching primitive.
    const body = roleSource.slice(roleSource.indexOf('export const BUILT_IN_ROLES'))
    for (const forbidden of [
      'PERMISSION_IDS',
      'PERMISSIONS',
      'startsWith',
      'endsWith',
      'filter(',
      'RegExp',
      '.*',
      'Object.keys',
      '...',
    ]) {
      expect(body.includes(forbidden), forbidden).toBe(false)
    }
  })

  it('grants nothing implicitly when the catalog grows', () => {
    // Simulate a catalog with one more permission: no role list may change,
    // because role lists are literals and resolution is exact membership.
    const grown = [...PERMISSION_IDS, 'targets.destroy_everything']
    for (const role of BUILT_IN_ROLE_IDS) {
      const before = [...rolePermissions(role)]
      const held = grown.filter((p) => (rolePermissions(role) as readonly string[]).includes(p))
      expect(held.sort(), role).toEqual(before.sort())
      expect(held, role).not.toContain('targets.destroy_everything')
    }
  })

  it('pins the owner list to the 27 permissions of the catalog at the time of writing', () => {
    // When the catalog grows, this test fails until a reviewed change decides
    // whether the owner gets the new permission (explicitly, never by default).
    expect([...rolePermissions('owner')].sort()).toEqual([...PERMISSION_IDS].sort())
    expect(PERMISSION_IDS.length).toBe(27)
  })

  it('resolves the documented summaries security-first', () => {
    const has = (role: BuiltInRoleId, p: Permission) => rolePermissions(role).includes(p)
    // admin: everything except break-glass (owner power); owner-only changes are policy.
    expect(PERMISSION_IDS.filter((p) => !has('admin', p))).toEqual(['breakglass.activate'])
    // operator: on call, no data or sensitive reads, no access or policy management.
    for (const p of [
      'data.read',
      'data.read_sensitive',
      'diagnostics.read_sensitive',
      'access.read',
      'access.manage',
      'policy.manage',
      'breakglass.activate',
      'migrations.import',
      'registry.manage',
      'restore.execute',
    ] as const) {
      expect(has('operator', p), p).toBe(false)
    }
    expect(has('operator', 'operations.recover')).toBe(true)
    expect(has('operator', 'plans.approve')).toBe(true)
    // developer: no sensitive, governance or approval permission.
    for (const p of [
      'data.read_sensitive',
      'diagnostics.read_sensitive',
      'plans.approve',
      'access.read',
      'audit.read',
      'migrations.import',
    ] as const) {
      expect(has('developer', p), p).toBe(false)
    }
    expect(has('developer', 'data.read')).toBe(true)
    // viewer: exactly the documented six reads.
    expect([...rolePermissions('viewer')].sort()).toEqual(
      [
        'targets.read',
        'schema.read',
        'diagnostics.read',
        'migrations.read',
        'backups.read',
        'nodes.read',
      ].sort(),
    )
    // auditor: audit and access reads, never data.
    expect(has('auditor', 'audit.read')).toBe(true)
    expect(has('auditor', 'access.read')).toBe(true)
    expect(has('auditor', 'data.read')).toBe(false)
    expect(rolePermissions('auditor').some((p) => !p.endsWith('.read'))).toBe(false)
  })

  it('gives human-only permissions only to roles of people', () => {
    const humanOnly = PERMISSION_IDS.filter((p) => PERMISSIONS[p].humanOnly)
    for (const p of humanOnly) {
      for (const role of BUILT_IN_ROLE_IDS) {
        if (rolePermissions(role).includes(p)) {
          expect(['owner', 'admin', 'operator'], `${role} holds ${p}`).toContain(role)
        }
      }
    }
  })

  it('matches the matrix in authorization.md §3.1 cell by cell', () => {
    const doc = section(
      readDoc('08-auth-and-security/authorization.md'),
      '### 3.1 The built-in role matrix (Wave 3A)',
    )
    const rows = tableRows(doc)
    const documented = new Map<string, Set<string>>()
    for (const row of rows) {
      const p = row[0]?.match(/^`([a-z_.]+)`$/)?.[1]
      if (p === undefined) {
        continue
      }
      BUILT_IN_ROLE_IDS.forEach((role, i) => {
        if (row[i + 1] === 'yes') {
          const set = documented.get(role) ?? new Set<string>()
          set.add(p)
          documented.set(role, set)
        }
      })
    }
    expect(rows.filter((r) => /^`/.test(r[0] ?? '')).length).toBe(PERMISSION_IDS.length)
    for (const role of BUILT_IN_ROLE_IDS) {
      expect([...(documented.get(role) ?? [])].sort(), role).toEqual(
        [...BUILT_IN_ROLES[role].permissions].sort(),
      )
    }
  })
})
