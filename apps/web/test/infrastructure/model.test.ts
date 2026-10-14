import { describe, expect, it } from 'vitest'
import {
  credentialsPath,
  DANGEROUS_ATTRIBUTES,
  dangerousGrants,
  emptyRole,
  enrollmentTokensOf,
  expiryState,
  isConsumerRoleName,
  knownNodeState,
  NODE_STATES,
  nodeHealth,
  observedRoles,
  roleProblem,
  roleSteps,
  servingNode,
  skewBeyondTolerance,
} from '../../src/features/infrastructure/model.ts'
import { credentialTarget } from '../../src/lib/navigation/links.ts'
import { CLUSTER, enrollPlan, SERVER, TOKEN_ID } from './support.tsx'

describe('node health', () => {
  it('is green only for an active node; unknown and pending enrollment are never green', () => {
    expect(nodeHealth('active')).toBe('healthy')
    for (const state of NODE_STATES.filter((s) => s !== 'active')) {
      expect(nodeHealth(state), state).not.toBe('healthy')
    }
    expect(nodeHealth('unknown')).toBe('unknown')
    expect(nodeHealth('pending_enrollment')).toBe('unknown')
    expect(nodeHealth('offline')).toBe('unhealthy')
    // A state this release does not know is unknown, never healthy.
    expect(nodeHealth('some_new_state')).toBe('unknown')
    expect(knownNodeState('some_new_state')).toBe('unknown')
  })

  it('warns about a clock skew beyond the 30 seconds a job tolerates', () => {
    expect(skewBeyondTolerance(null)).toBe(false)
    expect(skewBeyondTolerance(30_000)).toBe(false)
    expect(skewBeyondTolerance(-30_001)).toBe(true)
  })

  it('finds the node that serves a server, never a revoked or decommissioned one', () => {
    const nodes = [
      { id: 'a', serverId: SERVER, state: 'revoked' },
      { id: 'b', serverId: SERVER, state: 'degraded' },
    ]
    expect(servingNode(nodes, SERVER)?.id).toBe('b')
    expect(servingNode(nodes.slice(0, 1), SERVER)).toBeUndefined()
    expect(servingNode(nodes, null)).toBeUndefined()
  })
})

describe('certificate expiry', () => {
  const now = Date.parse('2026-10-13T00:00:00Z')
  it('tells expired, soon, valid, not yet valid and unknown apart', () => {
    expect(expiryState('2026-10-12T00:00:00Z', now)).toBe('expired')
    expect(expiryState('2026-10-20T00:00:00Z', now)).toBe('soon')
    expect(expiryState('2027-10-20T00:00:00Z', now)).toBe('valid')
    expect(expiryState('2027-10-20T00:00:00Z', now, undefined, '2026-11-01T00:00:00Z')).toBe(
      'not_yet',
    )
    expect(expiryState('not a date', now)).toBe('unknown')
  })
})

describe('desired roles', () => {
  const role = (name: string, over: Partial<ReturnType<typeof emptyRole>> = {}) => ({
    ...emptyRole(name),
    name,
    ...over,
  })

  it('builds one typed step per role, never a password step', () => {
    const steps = roleSteps([
      role('shop_app', {
        attributes: { ...emptyRole('x').attributes, login: 'grant', bypassrls: 'revoke' },
        connectionLimit: '20',
      }),
    ])
    expect(steps).toEqual([
      {
        op: 'create_role',
        role: 'shop_app',
        attributes: {
          login: true,
          inherit: null,
          createdb: null,
          createrole: null,
          replication: null,
          bypassrls: false,
          connectionLimit: 20,
        },
        verifier: null,
        member: null,
        admin: null,
        inherit: null,
        set: null,
        database: null,
        setting: null,
        value: null,
      },
    ])
    expect(JSON.stringify(steps)).not.toContain('set_password')
  })

  it('names the dangerous grants: BYPASSRLS, REPLICATION and CREATEROLE', () => {
    expect(DANGEROUS_ATTRIBUTES).toEqual(['bypassrls', 'replication', 'createrole'])
    const grants = dangerousGrants([
      role('a', { attributes: { ...emptyRole('x').attributes, createdb: 'grant' } }),
      role('b', {
        attributes: { ...emptyRole('x').attributes, replication: 'grant', bypassrls: 'revoke' },
      }),
    ])
    expect(grants).toEqual([{ role: 'b', attribute: 'replication' }])
  })

  it('checks names, duplicates and the connection limit before anything is sent', () => {
    expect(roleProblem([role('Shop')])).toEqual({ kind: 'name', index: 0 })
    expect(roleProblem([role('a'), role('a')])).toEqual({ kind: 'duplicate', index: 1 })
    expect(roleProblem([role('a', { connectionLimit: '-2' })])).toEqual({ kind: 'limit', index: 0 })
    expect(roleProblem([role('a', { connectionLimit: '-1' })])).toEqual({ kind: 'none' })
  })

  it('accepts consumer roles only for a verifier', () => {
    expect(isConsumerRoleName('shop_app')).toBe(true)
    expect(isConsumerRoleName('pg_read_all_data')).toBe(false)
    expect(isConsumerRoleName('exponetdb_reader')).toBe(false)
    expect(isConsumerRoleName('<script>')).toBe(false)
  })

  it('reads the roles of an observation defensively and counts what it cannot read', () => {
    const { roles, unreadable } = observedRoles({
      roles: [
        {
          name: 'shop_app',
          login: true,
          superuser: false,
          createrole: false,
          replication: false,
          bypassrls: false,
          password: ['scram', 'sha-256'].join('-'),
        },
        { name: 'broken', login: 'yes' },
        'nonsense',
      ],
    })
    expect(roles.map((r) => r.name)).toEqual(['shop_app'])
    expect(unreadable).toBe(2)
    expect(observedRoles(null)).toEqual({ roles: [], unreadable: 1 })
  })
})

describe('enrollment tokens and links', () => {
  it('takes the token and server of an applied node.enroll plan only', () => {
    expect(enrollmentTokensOf([enrollPlan()])).toEqual([
      expect.objectContaining({ tokenId: TOKEN_ID, serverId: SERVER }),
    ])
    expect(enrollmentTokensOf([enrollPlan({ state: 'active' })])).toEqual([])
    expect(
      enrollmentTokensOf([
        enrollPlan({ change: { content: { serverId: SERVER, tokenId: '../x' }, analysis: {} } }),
      ]),
    ).toEqual([])
  })

  it('builds the credentials hand-off in the grammar the credentials page accepts', () => {
    const path = credentialsPath(CLUSTER, 'reader') ?? ''
    expect(path).toBe(`/credentials#cluster=${CLUSTER}&role=reader`)
    expect(credentialTarget(path.slice('/credentials'.length))).toEqual({
      cluster: CLUSTER,
      role: 'reader',
    })
    expect(credentialsPath('cls_bad', 'reader')).toBeUndefined()
  })
})
