import { describe, expect, it } from 'vitest'
import {
  CLIENT_KINDS,
  isScope,
  isScopeGrantableTo,
  MCP_BASELINE_SCOPES,
  MCP_INELIGIBLE_SCOPES,
  PERMISSION_IDS,
  PERMISSIONS,
  SCOPE_IDS,
  SCOPES,
  type Scope,
  type ScopeDefinition,
  tieredScope,
} from '../src/index.ts'
import { readDoc, section, tableRows } from './docs.ts'

const authorization = readDoc('08-auth-and-security/authorization.md')

describe('permission catalog', () => {
  it('matches authorization.md §2 exactly', () => {
    const documented = tableRows(section(authorization, '## 2. Permissions'))
      .map((r) => r[0]?.match(/^`([a-z_.]+)`$/)?.[1])
      .filter((p): p is string => p !== undefined)
    expect([...PERMISSION_IDS].sort()).toEqual([...documented].sort())
  })

  it('has no wildcard and only <domain>.<verb> names', () => {
    for (const p of PERMISSION_IDS) {
      expect(p).toMatch(/^[a-z]+\.[a-z_]+$/)
      expect(p).not.toContain('*')
    }
  })

  it('marks the documented human-only permissions', () => {
    const humanOnly = PERMISSION_IDS.filter((p) => PERMISSIONS[p].humanOnly)
    expect(humanOnly.sort()).toEqual([
      'breakglass.activate',
      'diagnostics.read_sensitive',
      'operations.recover',
      'plans.approve',
      'restore.execute',
    ])
  })
})

const scopeSection = section(authorization, '## 4. OAuth scopes')
const [scopeTable = '', neverMcpText = ''] = scopeSection.split(
  '**Never grantable to OAuth clients of kind `mcp`**',
)
const documentedNeverMcp = [
  ...(neverMcpText.match(/\):([\s\S]*?)These actions/)?.[1] ?? '').matchAll(/`([a-z_.]+)`/g),
].map((m) => m[1])

describe('scope catalog', () => {
  const def = (s: Scope): ScopeDefinition => SCOPES[s]

  it('contains every scope of authorization.md §4 with the documented permission', () => {
    for (const row of tableRows(scopeTable)) {
      const scope = row[0]?.match(/^`([a-z_.:]+)`$/)?.[1]
      if (scope === undefined) {
        continue
      }
      expect(SCOPE_IDS, scope).toContain(scope)
      if (!isScope(scope)) {
        throw new Error(`${scope} (authorization.md §4) is not a catalog scope`)
      }
      const permission = row[1]?.match(/^`([a-z_.]+)`$/)?.[1]
      if (permission !== undefined) {
        expect(def(scope).permission, scope).toBe(permission)
      }
      expect(def(scope).mcpGrantable, scope).toBe(row[2]?.startsWith('yes') ?? false)
    }
  })

  it('encodes the documented MCP-ineligible scopes, and only scopes that are not delegable to MCP', () => {
    expect(documentedNeverMcp.length).toBe(11)
    for (const s of documentedNeverMcp) {
      expect(MCP_INELIGIBLE_SCOPES, s).toContain(s)
    }
    expect([...MCP_INELIGIBLE_SCOPES].sort()).toEqual(
      [...documentedNeverMcp, 'access.read', 'api'].sort(),
    )
  })

  it('references an existing permission from every scope (api is the only session-equivalent exception)', () => {
    for (const s of SCOPE_IDS) {
      const p = def(s).permission
      if (s === 'api') {
        expect(p).toBeNull()
      } else {
        expect(PERMISSION_IDS, s).toContain(p)
      }
    }
  })

  it('names untiered scopes after their permission and tiered scopes <permission>:<tier>', () => {
    for (const s of SCOPE_IDS) {
      const d = def(s)
      if (d.permission === null) {
        continue
      }
      expect(s).toBe(d.tier === null ? d.permission : `${d.permission}:${d.tier}`)
      expect(s).not.toContain('*')
    }
  })

  it('never lets prod and nonprod alias: tiered permissions have both, distinct, scopes and no untiered one', () => {
    const tieredPermissions = new Set(
      SCOPE_IDS.map((s) => def(s))
        .filter((d) => d.tier !== null)
        .map((d) => d.permission),
    )
    for (const p of tieredPermissions) {
      if (p === null) {
        throw new Error('a tiered scope has no permission')
      }
      const prod = tieredScope(p, 'prod')
      const nonprod = tieredScope(p, 'nonprod')
      expect(prod, p).toBeDefined()
      expect(nonprod, p).toBeDefined()
      expect(prod).not.toBe(nonprod)
      expect(SCOPE_IDS).not.toContain(p)
      if (prod === undefined || nonprod === undefined) {
        throw new Error(`${p}: missing tiered scope`)
      }
      expect(def(prod).tier).toBe('prod')
      expect(def(nonprod).tier).toBe('nonprod')
      expect(def(prod).explicitConsent).toBe(true)
    }
  })

  it('keeps MCP-ineligible scopes out of MCP grants: flag, client kinds and the grant filter agree', () => {
    for (const s of SCOPE_IDS) {
      const d = def(s)
      if (!d.mcpGrantable) {
        expect(d.clientKinds, s).not.toContain('mcp')
        expect(isScopeGrantableTo(s, 'mcp'), s).toBe(false)
      }
      if (d.humanOnly) {
        expect(d.mcpGrantable, s).toBe(false)
        expect(d.clientKinds, s).not.toContain('ci')
      }
      if (d.permission !== null && PERMISSIONS[d.permission].humanOnly) {
        expect(d.mcpGrantable, s).toBe(false)
        expect(d.humanOnly, s).toBe(true)
      }
    }
  })

  it('no MCP client can receive an admin or human-only scope, whatever it requests', () => {
    // Exhaustive over single scopes and a deterministic sample of request sets.
    let seed = 42
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed
    }
    for (let round = 0; round < 2000; round++) {
      const requested = SCOPE_IDS.filter(() => next() % 3 === 0)
      const granted = requested.filter((s) => isScopeGrantableTo(s, 'mcp'))
      for (const s of granted) {
        expect(MCP_INELIGIBLE_SCOPES).not.toContain(s)
        expect(def(s).humanOnly).toBe(false)
      }
    }
  })

  it('advertises only the documented minimal baseline in the protected resource metadata', () => {
    expect([...MCP_BASELINE_SCOPES].sort()).toEqual([
      'diagnostics.read',
      'schema.read',
      'targets.read',
    ])
  })

  it('only allows plan approval from the Web App', () => {
    expect(def('plans.approve').clientKinds).toEqual(['web'])
    for (const kind of CLIENT_KINDS) {
      expect(isScopeGrantableTo('plans.approve', kind)).toBe(kind === 'web')
    }
  })
})

describe('operations.recover (owner decision before G1)', () => {
  const scope: ScopeDefinition = SCOPES['operations.recover']

  it('is a catalog permission without wildcard, human only', () => {
    expect(PERMISSION_IDS).toContain('operations.recover')
    expect('operations.recover').toMatch(/^[a-z]+\.[a-z_]+$/)
    expect(PERMISSIONS['operations.recover'].humanOnly).toBe(true)
  })

  it('has a scope of the same name that only a human session in the Web App or first-party CLI can hold', () => {
    expect(SCOPE_IDS).toContain('operations.recover')
    expect(scope.permission).toBe('operations.recover')
    expect(scope.tier).toBeNull()
    expect(scope.mcpGrantable).toBe(false)
    expect(scope.humanOnly).toBe(true)
    expect([...scope.clientKinds].sort()).toEqual(['cli', 'web'])
    expect(MCP_INELIGIBLE_SCOPES).toContain('operations.recover')
    for (const kind of CLIENT_KINDS) {
      expect(isScopeGrantableTo('operations.recover', kind), kind).toBe(
        kind === 'web' || kind === 'cli',
      )
    }
  })
})
