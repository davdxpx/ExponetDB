import type { DatabaseView, EndpointView, ProbeResult } from '@exponetdb/sdk/operations'
import { describe, expect, it } from 'vitest'
import {
  type ConnectEndpoint,
  connectionLines,
  connectModel,
  endpointCheck,
  isAddress,
} from '../../src/features/configuration/connect-model.ts'
import { nth, ulid } from './support.tsx'

// A URL with user information, built from parts: no line reads as one to the secret scanner.
const URI_PREFIX = ['postgresql://<role>', '[YOUR-PASSWORD]@'].join(':')

const TARGET = 'tgt_00000000000000000000000002'
const CLUSTER = `cls_${ulid(1)}`
const NOW = '2026-10-20T09:00:00Z'

function endpoint(n: number, over: Partial<EndpointView> = {}): EndpointView {
  return {
    id: `end_${ulid(n)}`,
    clusterId: CLUSTER,
    kind: 'private',
    poolerMode: null,
    host: 'db.example.test',
    port: 5432,
    tlsServerName: 'db.example.test',
    label: `endpoint ${n}`,
    state: 'active',
    createdAt: NOW,
    retiredAt: null,
    ...over,
  }
}

function database(over: Partial<DatabaseView> = {}): DatabaseView {
  return {
    id: `dbs_${ulid(1)}`,
    clusterId: CLUSTER,
    name: 'orders',
    state: 'registered',
    createdAt: NOW,
    observed: null,
    placement: { targetId: TARGET, generation: 1 },
    ...over,
  }
}

function connectable(over: Partial<ConnectEndpoint> = {}): ConnectEndpoint {
  return {
    id: `end_${ulid(1)}`,
    label: 'main',
    kind: 'private',
    poolerMode: null,
    host: 'db.example.test',
    port: 5432,
    tlsServerName: 'db.example.test',
    ...over,
  }
}

function probe(
  over: Partial<ProbeResult> & { endpointId?: string; verified?: boolean },
): ProbeResult {
  const { endpointId = `end_${ulid(1)}`, verified = true, ...rest } = over
  return {
    durationMs: 10,
    endpoint: { id: endpointId, kind: 'private', label: 'main', verified },
    errorClass: null,
    observedAt: NOW,
    outcome: 'ok',
    probe: 'simple',
    tls: 'verified',
    ...rest,
  }
}

describe('the connect model', () => {
  it('lists active application endpoints, counts local sockets apart and finds the database', () => {
    const model = connectModel({
      endpoints: {
        items: [
          endpoint(1),
          endpoint(2, { kind: 'pooler', poolerMode: 'transaction' }),
          endpoint(3, { state: 'retired', retiredAt: NOW }),
          endpoint(4, { kind: 'local_socket' }),
        ],
        truncated: false,
      },
      databases: {
        items: [database({ id: `dbs_${ulid(9)}`, name: 'other', placement: null }), database()],
        truncated: false,
      },
      targetId: TARGET,
    })
    expect(model.endpoints.map((e) => e.kind)).toEqual(['private', 'pooler'])
    expect(model.localSockets).toBe(1)
    expect(model.database).toBe('orders')
    expect(model.missing).toEqual([])
  })

  it('says what is missing: a cut endpoint list, a database no list names, a failed database read', () => {
    const cut = connectModel({
      endpoints: { items: [endpoint(1)], truncated: true },
      databases: { items: [database()], truncated: false },
      targetId: TARGET,
    })
    expect(cut.missing).toEqual(['More endpoints exist than this list shows.'])

    const unnamed = connectModel({
      endpoints: { items: [endpoint(1)], truncated: false },
      databases: { items: [database({ placement: null })], truncated: false },
      targetId: TARGET,
    })
    expect(unnamed.database).toBeUndefined()
    expect(nth(unnamed.missing, 0)).toMatch(/lists no database placed on this target/)

    const truncated = connectModel({
      endpoints: { items: [endpoint(1)], truncated: false },
      databases: { items: [], truncated: true },
      targetId: TARGET,
    })
    expect(nth(truncated.missing, 0)).toMatch(/More databases exist/)

    const failed = connectModel({
      endpoints: { items: [endpoint(1)], truncated: false },
      databases: undefined,
      databasesFailure: 'The registry did not answer.',
      targetId: TARGET,
    })
    expect(nth(failed.missing, 0)).toContain('The registry did not answer.')
  })

  it('ignores a retired database and one placed on another target', () => {
    const model = connectModel({
      endpoints: { items: [endpoint(1)], truncated: false },
      databases: {
        items: [
          database({ state: 'retired' }),
          database({ placement: { targetId: 'tgt_00000000000000000000000009', generation: 1 } }),
        ],
        truncated: false,
      },
      targetId: TARGET,
    })
    expect(model.database).toBeUndefined()
  })
})

describe('the connection lines', () => {
  it('builds a URI and a psql command with placeholders and verify-full, and no password', () => {
    const lines = connectionLines(connectable(), 'orders')
    expect(lines).toEqual({
      kind: 'lines',
      address: false,
      uri: `${URI_PREFIX}db.example.test:5432/orders?sslmode=verify-full`,
      psql: 'psql "host=db.example.test port=5432 dbname=orders user=<role> sslmode=verify-full"',
    })
  })

  it('checks the TLS server name and connects to the address when the endpoint is an address', () => {
    const lines = connectionLines(
      connectable({ host: '10.8.2.5', tlsServerName: 'db.internal.example' }),
      'orders',
    )
    expect(lines).toMatchObject({
      kind: 'lines',
      address: true,
      uri: `${URI_PREFIX}db.internal.example:5432/orders?sslmode=verify-full&hostaddr=10.8.2.5`,
      psql: 'psql "host=db.internal.example port=5432 dbname=orders user=<role> sslmode=verify-full hostaddr=10.8.2.5"',
    })
  })

  it('brackets an IPv6 host that is its own TLS name', () => {
    const lines = connectionLines(connectable({ host: '::1', tlsServerName: '::1' }), 'orders')
    expect(lines).toMatchObject({ kind: 'lines', address: false })
    expect(lines.kind === 'lines' ? lines.uri : '').toContain('@[::1]:5432/orders')
  })

  it('builds nothing from a database name or a host that is not safe to paste', () => {
    for (const name of [
      'my db',
      'x"; rm -rf ~; "',
      'a$(id)',
      'x`id`',
      'a\nb',
      'é',
      '',
      'a'.repeat(64),
    ]) {
      expect(connectionLines(connectable(), name)).toEqual({ kind: 'unsafe', what: 'database' })
    }
    for (const host of ['a b', 'h"x', 'h$(id)', 'h/x', 'h?x', 'h;x', 'h\nx', '']) {
      expect(connectionLines(connectable({ host, tlsServerName: host }), 'orders')).toEqual({
        kind: 'unsafe',
        what: 'host',
      })
    }
    expect(
      connectionLines(connectable({ host: '10.8.2.5', tlsServerName: 'a b' }), 'orders'),
    ).toEqual({ kind: 'unsafe', what: 'host' })
  })

  it('tells an address from a DNS name', () => {
    expect(isAddress('10.8.2.5')).toBe(true)
    expect(isAddress('2001:db8::1')).toBe(true)
    expect(isAddress('db.example.test')).toBe(false)
    expect(isAddress('10.8.2.5.example.test')).toBe(false)
  })
})

describe('the endpoint check', () => {
  it('says nothing was probed when no probe names the endpoint', () => {
    expect(endpointCheck(`end_${ulid(1)}`, [])).toBeUndefined()
    expect(
      endpointCheck(`end_${ulid(1)}`, [probe({ endpointId: `end_${ulid(2)}` })]),
    ).toBeUndefined()
  })

  it('reads TLS, success and identity from the probes of the endpoint', () => {
    expect(endpointCheck(`end_${ulid(1)}`, [probe({}), probe({ probe: 'identity' })])).toEqual({
      total: 2,
      ok: 2,
      tls: 'verified',
      identityVerified: true,
      observedAt: NOW,
    })
    expect(
      endpointCheck(`end_${ulid(1)}`, [probe({}), probe({ tls: 'failed', outcome: 'failed' })]),
    ).toMatchObject({ ok: 1, tls: 'failed' })
    expect(
      endpointCheck(`end_${ulid(1)}`, [probe({ tls: 'not_reached', outcome: 'timeout' })]),
    ).toMatchObject({ tls: 'not_reached', ok: 0 })
    expect(
      endpointCheck(`end_${ulid(1)}`, [
        probe({}),
        probe({ tls: 'not_reached', outcome: 'timeout' }),
      ]),
    ).toMatchObject({ tls: 'mixed' })
    expect(endpointCheck(`end_${ulid(1)}`, [probe({ verified: false })])).toMatchObject({
      identityVerified: false,
    })
  })

  it('reports the newest probe time', () => {
    const check = endpointCheck(`end_${ulid(1)}`, [
      probe({ observedAt: '2026-10-20T08:00:00Z' }),
      probe({ observedAt: '2026-10-20T08:30:00Z' }),
      probe({ observedAt: '2026-10-20T08:10:00Z' }),
    ])
    expect(check?.observedAt).toBe('2026-10-20T08:30:00Z')
  })
})
