import { join } from 'node:path'
import { migratedTestDatabase } from '@exponetdb/control-store/testing'
import { generateKeyringText } from '@exponetdb/secrets'
import { describe, expect, it } from 'vitest'
import { runGateway } from '../../src/roles/roles.ts'
import { eventually, hostScenario, SERVER_NAME } from '../support/host-world.ts'

/**
 * Host scenario: a node's life from the Web App's enrollment token to its
 * revocation (control-plane.md §4 to §6), with the real agent and helper on
 * a cluster of their own. The token is planned, applied, revealed once and
 * spent once; the agent pins the gateway's root, so a gateway of another
 * installation at the same address gets nothing; the certificate renews; a
 * revoked node is refused at its next request and runs nothing more.
 */
const w = hostScenario({ scenario: 'enrollment', enroll: false })
let nodeId = ''
let token = ''

describe('node enrollment, root pinning, renewal and revocation (host scenario)', () => {
  it('enrolls with a token the Web App revealed once; the spent token enrolls nothing else', async () => {
    const planned = await w.call('POST', `/api/v1/servers/${w.serverId}/nodes/enroll`, {})
    expect([planned.status, planned.body.kind]).toEqual([201, 'node.enroll'])
    const tokenId: string = planned.body.change.content.tokenId
    await w.reauth()
    const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status, JSON.stringify(applied.body)).toBe(202)
    const done = await w.finished(applied.body.id)
    expect([done.state, done.verificationOutcome]).toEqual(['succeeded', 'passed'])
    await w.reauth()
    const revealed = await w.call('POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {})
    expect(revealed.status).toBe(200)
    token = revealed.body.token
    expect((await w.call('POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {})).status).toBe(
      404,
    )
    const node = await w.enrollNode(token)
    nodeId = node.nodeId
    await w.inspect('postgres.status@1')
    // The token is spent: a second agent state enrolls nothing with it.
    const second = await w.prepareNode('-second')
    const again = await w.runEnroll(second, token)
    expect(again.ok).toBe(false)
    expect(
      await w.sql('SELECT count(*)::int AS n FROM nodes.nodes WHERE server_id = $1', [w.serverId]),
    ).toEqual([{ n: 1 }])
    const nodes = await w.call('GET', '/api/v1/nodes')
    expect(nodes.body.items.map((n: { id: string; state: string }) => [n.id, n.state])).toEqual([
      [nodeId, 'active'],
    ])
  })

  it('pins the gateway root: a gateway of another installation at the same address learns nothing', async () => {
    const rogue = await migratedTestDatabase('exdb_host_enrollment_rogue')
    const rogueKeyring = generateKeyringText('k2026r')
    try {
      const { runCommand } = await import('../../src/commands/index.ts')
      const ceremony = await runCommand(
        [
          'node-pki',
          'init',
          '--gateway-url',
          `https://127.0.0.1:${w.port}`,
          '--server-name',
          SERVER_NAME,
          '--root-key-out',
          join(w.dir, 'rogue-root-key.pem'),
        ],
        {
          env: {
            EXPONETDB_CONTROL_STORE_URL: rogue.url('exdb_worker'),
            EXPONETDB_KEYRING: rogueKeyring,
          },
          stdout: () => undefined,
          stderr: () => undefined,
        },
      )
      expect(ceremony).toBe(0)
      const helloBefore = await w.sql('SELECT last_hello_at FROM nodes.nodes WHERE node_id = $1', [
        nodeId,
      ])
      const mark = w.logMark()
      await w.stopGateway()
      const stopRogue = w.startRole((hooks) =>
        runGateway(
          {
            ...w.gatewayConfig,
            controlStoreUrl: rogue.url('exdb_gateway'),
            installationId: rogue.installationId,
            keyringEnv: { EXPONETDB_KEYRING: rogueKeyring },
          },
          hooks,
        ),
      )
      try {
        // The rogue chain fails the agent's verification against its pinned
        // root (Go's verifier says so first; transport.go checks the pin too).
        await eventually(
          'the agent to refuse the rogue chain',
          () => w.logs(mark),
          (text) =>
            /certificate signed by unknown authority|does not contain the pinned root/.test(text),
          60_000,
        )
        const reached = await rogue.asSuperuser((c) =>
          c.query('SELECT count(*)::int AS n FROM nodes.nodes'),
        )
        // The agent stopped at the TLS handshake: it sent the rogue gateway no request.
        expect(reached.rows).toEqual([{ n: 0 }])
        expect(await w.logs(mark)).not.toContain('NODE_CERTIFICATE_REFUSED')
      } finally {
        await stopRogue()
        w.startGateway()
      }
      await eventually(
        'a hello at the real gateway again',
        () => w.sql('SELECT last_hello_at FROM nodes.nodes WHERE node_id = $1', [nodeId]),
        (rows) =>
          rows[0]?.last_hello_at !== null &&
          new Date(rows[0]?.last_hello_at).getTime() >
            new Date(helloBefore[0]?.last_hello_at).getTime(),
        120_000,
      )
      await w.inspect('postgres.status@1')
    } finally {
      await rogue.drop()
    }
  })

  it('renews its certificate once a third of its lifetime is left, and keeps working', async () => {
    const before = await w.sql('SELECT certificate FROM nodes.nodes WHERE node_id = $1', [nodeId])
    await w.sql(
      `UPDATE nodes.nodes SET certificate_expires_at = clock_timestamp() + interval '1 hour' WHERE node_id = $1`,
      [nodeId],
    )
    const renewed = await eventually(
      'a renewal',
      () =>
        w.sql(
          'SELECT certificate, certificate_renewed_at, previous_certificate FROM nodes.nodes WHERE node_id = $1',
          [nodeId],
        ),
      (rows) => rows[0]?.certificate_renewed_at !== null && rows[0]?.previous_certificate === null,
      120_000,
    )
    expect(Buffer.compare(renewed[0]?.certificate, before[0]?.certificate)).not.toBe(0)
    const audit = await w.sql(
      `SELECT action FROM audit.audit_events WHERE event::jsonb->'subject'->>'nodeId' = $1`,
      [nodeId],
    )
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining(['node.enrolled', 'node.bound', 'node.certificate_renewed']),
    )
    await w.inspect('postgres.status@1')
  })

  it('is refused at its next request once revoked, and runs nothing more', async () => {
    const mark = w.logMark()
    const planned = await w.call('POST', `/api/v1/nodes/${nodeId}/revoke`, {})
    expect(planned.status, JSON.stringify(planned.body)).toBe(201)
    await w.reauth()
    const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status, JSON.stringify(applied.body)).toBe(202)
    const done = await w.finished(applied.body.id)
    expect([done.state, done.verificationOutcome]).toEqual(['succeeded', 'passed'])
    await eventually(
      'the refusal',
      () => w.logs(mark),
      (text) => text.includes('NODE_CERTIFICATE_REFUSED'),
      60_000,
    )
    const last = await w.sql('SELECT last_heartbeat_at FROM nodes.nodes WHERE node_id = $1', [
      nodeId,
    ])
    await new Promise((r) => setTimeout(r, 5_000))
    expect(
      await w.sql('SELECT last_heartbeat_at FROM nodes.nodes WHERE node_id = $1', [nodeId]),
    ).toEqual(last)
    const read = await w.call('POST', `/api/v1/nodes/${nodeId}/inspections`, {
      capability: 'postgres.status@1',
      clusterId: w.clusterId,
      args: {},
    })
    expect(read.status).not.toBe(202)
    // Nothing the agent or the helper logged carries the token.
    expect(await w.logs()).not.toContain(token.slice(7, 47))
  })
})
