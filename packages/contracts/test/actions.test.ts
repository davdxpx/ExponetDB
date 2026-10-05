import { describe, expect, it } from 'vitest'
import {
  ACTION_IDS,
  ACTIONS,
  type ActionDefinition,
  type ActionId,
  isActionId,
  isScope,
  PERMISSION_IDS,
  PERMISSIONS,
  SCOPES,
  type Scope,
  type ScopeDefinition,
  tieredScope,
} from '../src/index.ts'
import { readDoc, section, tableRows } from './docs.ts'

const def = (id: ActionId): ActionDefinition => ACTIONS[id]

/** Scopes an action can require, resolved from its rule. */
function scopesOf(a: ActionDefinition): Scope[] {
  switch (a.scope.kind) {
    case 'fixed':
      return [a.scope.scope]
    case 'tiered': {
      const prod = tieredScope(a.scope.permission, 'prod')
      const nonprod = tieredScope(a.scope.permission, 'nonprod')
      if (prod === undefined || nonprod === undefined) {
        throw new Error(`missing tiered scope for ${a.scope.permission}`)
      }
      return [prod, nonprod]
    }
    default:
      return []
  }
}

describe('action registry', () => {
  it('has unique dotted ids', () => {
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length)
    for (const id of ACTION_IDS) {
      expect(id).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/)
    }
  })

  it('references existing permissions and scopes; fixed scopes carry the action permission', () => {
    for (const id of ACTION_IDS) {
      const a = def(id)
      if (a.permission.kind === 'fixed') {
        expect(PERMISSION_IDS, id).toContain(a.permission.permission)
      } else {
        expect(['plan', 'operation'], id).toContain(a.subject)
      }
      for (const s of scopesOf(a)) {
        expect(isScope(s), `${id} → ${s}`).toBe(true)
        const sd: ScopeDefinition = SCOPES[s]
        if (a.permission.kind === 'fixed') {
          expect(sd.permission, id).toBe(a.permission.permission)
        }
      }
      if (a.scope.kind === 'tiered' && a.permission.kind === 'fixed') {
        expect(a.scope.permission, id).toBe(a.permission.permission)
      }
    }
  })

  it('never lets a human-only action list MCP or service accounts', () => {
    for (const id of ACTION_IDS) {
      const a = def(id)
      if (a.humanOnly) {
        expect(a.clientKinds, id).not.toContain('mcp')
        expect(a.clientKinds, id).not.toContain('ci')
        expect(a.clientKinds.length, id).toBeGreaterThan(0)
      }
      if (a.permission.kind === 'fixed' && PERMISSIONS[a.permission.permission].humanOnly) {
        expect(a.humanOnly, id).toBe(true)
      }
    }
  })

  it('allows a client kind only when every scope the action can need is grantable to it', () => {
    for (const id of ACTION_IDS) {
      const a = def(id)
      for (const s of scopesOf(a)) {
        const sd: ScopeDefinition = SCOPES[s]
        for (const kind of a.clientKinds) {
          expect(sd.clientKinds, `${id} via ${kind} needs ${s}`).toContain(kind)
          if (kind === 'mcp') {
            expect(sd.mcpGrantable, `${id} needs ${s}`).toBe(true)
          }
        }
      }
    }
  })

  it('classifies consistently (C-6): consequential actions are planned, verified and never class read', () => {
    for (const id of ACTION_IDS) {
      const a = def(id)
      const classes =
        a.class.kind === 'fixed'
          ? [a.class.class]
          : a.class.kind === 'by_tier'
            ? [a.class.nonprod, a.class.prod]
            : [...a.class.possible]
      if (a.effect === 'consequential') {
        expect(['inline_plan', 'stored_plan', 'plan_apply'], id).toContain(a.mechanism)
        expect(a.verification, id).toBe('required')
        expect(classes, id).not.toContain('read')
        if (a.mechanism !== 'plan_apply') {
          expect(a.operationKind, id).toBe(true)
        }
      } else {
        expect(a.mechanism, id).toBe('none')
        expect(classes, id).toEqual(['read'])
        expect(a.exclusivity, id).toEqual([])
        expect(a.operationKind, id).toBe(false)
      }
      if (a.mechanism === 'inline_plan') {
        expect(classes, id).toEqual(['low'])
      }
      if (a.mechanism === 'stored_plan') {
        expect(
          classes.every((c) => c === 'standard' || c === 'high' || c === 'critical'),
          id,
        ).toBe(true)
      }
      if (a.class.kind === 'fixed' && a.class.class === 'critical') {
        expect(a.humanOnly, id).toBe(true)
      }
      if (a.class.kind === 'by_tier') {
        expect(a.tierSemantics, id).not.toBe('none')
      }
      if (a.scope.kind === 'tiered') {
        expect(a.tierSemantics, id).not.toBe('none')
      }
    }
  })

  it('registers every operation kind of operations-engine.md §2', () => {
    const doc = section(readDoc('02-control-plane/operations-engine.md'), '## 2. Operation kinds')
    const kinds = tableRows(doc)
      .flatMap((r) => [...(r[0] ?? '').matchAll(/`([a-z][a-z_.]*)`/g)].map((m) => m[1] ?? ''))
      .filter((k) => /^[a-z_]+(\.[a-z_]+)+$/.test(k) && !k.endsWith('.sql'))
    expect(kinds.length).toBeGreaterThan(25)
    for (const k of kinds) {
      expect(ACTION_IDS, k).toContain(k)
      if (!isActionId(k)) {
        throw new Error(`${k} (operations-engine.md §2) is not a registered action`)
      }
      expect(def(k).operationKind, k).toBe(true)
    }
  })

  it('takes the target schema domain for every schema-changing kind (C-18)', () => {
    for (const id of [
      'migration.apply',
      'migration.rollback',
      'migration.baseline',
      'migration.resume',
      'ledger.reconcile',
    ] as const) {
      expect(def(id).exclusivity, id).toContain('target.schema')
    }
  })
})
