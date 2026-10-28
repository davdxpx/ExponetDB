// R2 probe (E6/TC-048, E2/TC-016, E10/TC-053): a real agent on a real systemd host, enrolled through the
// product; probes the enrollment-token surface and then reads the node view. Copy to apps/server/test/host/.
import { describe, expect, it } from 'vitest'
import { hostScenario } from '../support/host-world.ts'

const w = hostScenario({ scenario: 'config', enroll: false })

describe('R2 probe (host)', () => {
  it('E6/TC-048 + E10/TC-053: enrollment token surface and the two step-ups', async () => {
    const planned = await w.call('POST', `/api/v1/servers/${w.serverId}/nodes/enroll`, {})
    const tokenId: string = planned.body.change.content.tokenId
    await w.reauth()
    const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    await w.finished(applied.body.id)
    // E10: the reveal right after the apply, without a second passkey: is it refused?
    const noSecond = await w.call('POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {})
    console.log('R2-E10 reveal without a second step-up ->', noSecond.status, String(noSecond.body?.code ?? ''))
    await w.reauth()
    const revealed = await w.call('POST', `/api/v1/enrollment-tokens/${tokenId}/reveal`, {})
    console.log('R2-E10 reveal after a second step-up ->', revealed.status)
    const probes: [string, string][] = [
      ['GET', '/api/v1/enrollment-tokens'],
      ['GET', `/api/v1/enrollment-tokens/${tokenId}`],
      ['GET', `/api/v1/servers/${w.serverId}/enrollment-tokens`],
      ['DELETE', `/api/v1/enrollment-tokens/${tokenId}`],
      ['POST', `/api/v1/enrollment-tokens/${tokenId}/revoke`],
    ]
    for (const [m, p] of probes) {
      const r = await w.call(m, p, m === 'POST' ? {} : undefined)
      console.log('R2-E6', m, p.replace(tokenId, '<token>').replace(w.serverId, '<server>'), '->', r.status, String(r.body?.code ?? ''))
    }
    console.log('R2-E6 token row before expiry', JSON.stringify(await w.sql('SELECT state FROM nodes.enrollment_tokens WHERE token_id = $1', [tokenId])))
    await w.sql("UPDATE nodes.enrollment_tokens SET expires_at = now() - interval '1 hour', reveal_until = now() - interval '1 hour' WHERE token_id = $1", [tokenId]).catch((e: unknown) => console.log('R2-E6 update refused:', String(e).slice(0, 120)))
    await new Promise((res) => setTimeout(res, 10_000))
    console.log('R2-E6 token row 10 s after expires_at passed', JSON.stringify(await w.sql('SELECT state, expires_at < now() AS past FROM nodes.enrollment_tokens WHERE token_id = $1', [tokenId])))
    expect(true).toBe(true)
  })

  it('E2/TC-016: the node view lists the clusters the node serves', async () => {
    await w.enrollNode(await w.enrollmentToken())
    const node = w.requireNode()
    await w.inspect('postgres.status@1')
    const r = await w.call('GET', `/api/v1/nodes/${node.nodeId}`)
    console.log('R2-E2 GET /nodes/{id} status', r.status, 'clusters', JSON.stringify(r.body.clusters), '| registry cluster id', w.clusterId)
    const rows = await w.sql("SELECT jsonb_array_length(clusters) AS hello_n, jsonb_array_length(heartbeat->'clusters') AS beat_n FROM nodes.nodes WHERE node_id = $1", [node.nodeId])
    console.log('R2-E2 stored cluster counts (hello column / heartbeat)', JSON.stringify(rows))
    expect(true).toBe(true)
  })
})
