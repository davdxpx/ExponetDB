import { describe, expect, it } from 'vitest'
import {
  ACTION_IDS,
  ACTIONS,
  type ActionDefinition,
  type ActionId,
  CredentialSubmissionSchema,
  contractJsonSchema,
  MCP_TOOL_LIST,
  REGISTRY_ROUTES,
  ROUTE_LIST,
  SCOPE_IDS,
  WRITE_SCOPES,
} from '../src/index.ts'

const def = (id: ActionId): ActionDefinition => ACTIONS[id]

/**
 * The write scopes of the accepted G3B baseline. The frozen `oauth.scopes`
 * catalog stores whether a scope writes; a Wave 4 action must never change
 * that answer (a read scope that became a write scope would silently widen
 * every grant that holds it).
 */
const G3B_WRITE_SCOPES = [
  'access.manage',
  'api',
  'backups.run',
  'breakglass.activate',
  'connections.operate:nonprod',
  'connections.operate:prod',
  'migrations.apply:nonprod',
  'migrations.apply:prod',
  'migrations.import',
  'migrations.plan',
  'nodes.operate:nonprod',
  'nodes.operate:prod',
  'nodes.plan',
  'operations.recover',
  'plans.approve',
  'policy.manage',
  'registry.manage',
  'restore.execute',
  'restore.plan',
  'schema.manage',
  'schema.read',
]

/** Property names that would be connection material or secret topology in a response. */
const FORBIDDEN_RESPONSE_FIELDS =
  /^(password|passwd|connectionString|connectionUri|dsn|credentialSecret|secret|secretId|secretRef|secretVersion|ciphertext|wrappedKey|privateKey|sslkey|sslKey|scramVerifier|verifier)$/i

/** Every property name in a JSON Schema, recursively. */
function propertyNames(schema: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(schema)) {
    for (const s of schema) propertyNames(s, out)
    return out
  }
  if (typeof schema !== 'object' || schema === null) return out
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      for (const name of Object.keys(v)) out.add(name)
    }
    propertyNames(v, out)
  }
  return out
}

/** Properties (name and schema) in a JSON Schema, recursively. */
function properties(schema: unknown, out: [string, unknown][] = []): [string, unknown][] {
  if (Array.isArray(schema)) {
    for (const s of schema) properties(s, out)
    return out
  }
  if (typeof schema !== 'object' || schema === null) return out
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && typeof v === 'object' && v !== null) {
      out.push(...Object.entries(v))
    }
    properties(v, out)
  }
  return out
}

/** A secret-named property that could carry a value (a boolean flag such as "has a password" cannot). */
function carriesValue(schema: unknown): boolean {
  return !(
    typeof schema === 'object' &&
    schema !== null &&
    (schema as { type?: unknown }).type === 'boolean'
  )
}

/** The API key of a service account is shown once at creation, by design (Wave 3B, oauth.md §8). */
const SHOWN_ONCE = new Set(['createApiKey.secret'])

describe('Wave 4 registry contracts', () => {
  it('keep the write-ness of every scope exactly as accepted with G3B', () => {
    expect([...WRITE_SCOPES].sort()).toEqual(G3B_WRITE_SCOPES)
    for (const scope of SCOPE_IDS) {
      expect(WRITE_SCOPES.has(scope), scope).toBe(G3B_WRITE_SCOPES.includes(scope))
    }
  })

  it('register every registry change as a human-only registry.manage plan or kind', () => {
    const registry = ACTION_IDS.filter(
      (id) =>
        id.startsWith('registry.') || /^target\.(register|suspend|resume|decommission)/.test(id),
    )
    expect(registry.length).toBeGreaterThan(25)
    for (const id of registry) {
      const a = def(id)
      expect(a.permission, id).toEqual({ kind: 'fixed', permission: 'registry.manage' })
      expect(a.scope, id).toEqual({ kind: 'fixed', scope: 'registry.manage' })
      expect(a.humanOnly, id).toBe(true)
      expect(a.clientKinds, id).not.toContain('mcp')
      expect(a.clientKinds, id).not.toContain('ci')
      if (id.endsWith('.plan')) {
        expect(a.effect, id).toBe('control_record')
        const kind = id.slice(0, -'.plan'.length)
        expect(ACTION_IDS, id).toContain(kind)
        expect(def(kind as ActionId).operationKind, kind).toBe(true)
        expect(def(kind as ActionId).mechanism, kind).toBe('stored_plan')
      }
    }
  })

  it('make the credential submission write-only: Web App, re-authentication, inline, verified', () => {
    const a = def('registry.credential.submit')
    expect(a.clientKinds).toEqual(['web'])
    expect(a.reauthentication).toBe(true)
    expect(a.reauthWithinSeconds).toBe(300)
    expect(a.mechanism).toBe('inline_plan')
    expect(a.verification).toBe('required')
    const body = contractJsonSchema(CredentialSubmissionSchema, { io: 'input' })
    expect(JSON.stringify(body)).toContain('"writeOnly":true')
  })

  it('require re-authentication where a change moves where ExponetDB connects', () => {
    for (const id of [
      'registry.cluster.register',
      'registry.cluster.confirm',
      'registry.endpoint.add',
      'registry.endpoint.retire',
      'registry.environment.update',
      'target.decommission',
    ] as const) {
      expect(def(id).reauthentication, id).toBe(true)
    }
  })

  it('never return connection material: no response or MCP output carries a password, DSN or secret field', () => {
    const offenders: string[] = []
    const check = (owner: string, schema: unknown) => {
      for (const [name, property] of properties(schema)) {
        const id = `${owner}.${name}`
        if (FORBIDDEN_RESPONSE_FIELDS.test(name) && carriesValue(property) && !SHOWN_ONCE.has(id)) {
          offenders.push(id)
        }
      }
    }
    for (const r of ROUTE_LIST) {
      check(r.operationId, contractJsonSchema(r.response.schema, { io: 'output' }))
    }
    for (const t of MCP_TOOL_LIST) {
      check(t.name, contractJsonSchema(t.input, { io: 'input' }))
      check(t.name, contractJsonSchema(t.output, { io: 'output' }))
    }
    expect(offenders).toEqual([])
  })

  it('accept a password only in the write-only credential submission body', () => {
    const carriers = ROUTE_LIST.filter(
      (r) =>
        r.body !== undefined &&
        propertyNames(contractJsonSchema(r.body, { io: 'input' })).has('password'),
    ).map((r) => r.operationId)
    expect(carriers).toEqual(['submitClusterCredential'])
  })

  it('never accept a connection string or a host from an API client outside endpoint registration', () => {
    for (const r of ROUTE_LIST) {
      const names = new Set<string>()
      for (const schema of [r.body, r.query, r.pathParams]) {
        if (schema !== undefined) {
          for (const n of propertyNames(contractJsonSchema(schema, { io: 'input' }))) names.add(n)
        }
      }
      for (const n of names) {
        expect(
          /^(dsn|connectionString|connectionUri|url|uri)$/i.test(n),
          `${r.operationId}.${n}`,
        ).toBe(false)
      }
      if (names.has('host')) {
        expect(['planClusterRegistration', 'planEndpoint'], r.operationId).toContain(r.operationId)
      }
    }
  })

  it('serve the registry routes under /api/v1 as plans (201) except the reads and the credential submission', () => {
    for (const r of REGISTRY_ROUTES) {
      if (r.method === 'get') {
        expect(r.response.status, r.operationId).toBe(200)
      } else if (r.operationId === 'submitClusterCredential') {
        expect(r.response.status).toBe(202)
      } else {
        expect(r.response.status, r.operationId).toBe(201)
        expect(def(r.action).effect, r.operationId).toBe('control_record')
      }
    }
  })
})
