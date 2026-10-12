import { describe, expect, it } from 'vitest'
import { hostScenario } from '../support/host-world.ts'

/**
 * Host scenario: job-key rotation with overlap (control-plane.md §9.8,
 * ADR-0024 §1, Wave 5 correction F8), on a node of its own. A key is staged,
 * added to the node, activated only once the node stated (node-signed) that
 * its agent and its root helper trust it, used for every job after that and
 * accepted by the helper too; the old key stays for the overlap, then leaves
 * the node and is retired.
 */
const w = hostScenario({ scenario: 'job-keys' })

async function jobKey(...args: string[]) {
  const r = await w.command(['node-pki', 'job-key', ...args])
  return { code: r.code, body: r.code === 0 ? JSON.parse(r.stdout) : undefined, error: r.stderr }
}

async function configUpdate(body: object) {
  const nodeId = w.requireNode().nodeId
  const planned = await w.call('POST', `/api/v1/nodes/${nodeId}/config-updates`, body)
  expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
    201,
    undefined,
  ])
  await w.reauth()
  const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect(applied.status, JSON.stringify(applied.body)).toBe(202)
  return w.finished(applied.body.id)
}

async function trustedKeys(): Promise<string[]> {
  const rows = await w.sql('SELECT trusted_job_keys FROM nodes.nodes WHERE node_id = $1', [
    w.requireNode().nodeId,
  ])
  return [...(rows[0]?.trusted_job_keys ?? [])].sort()
}

async function signers(operationId: string) {
  return (
    await w.sql(
      `SELECT capability, envelope->'signature'->>'keyId' AS key FROM nodes.jobs
        WHERE operation_id = $1 ORDER BY created_at`,
      [operationId],
    )
  ).map((r) => `${r.capability} ${r.key}`)
}

describe('job-key rotation with overlap, trusted by the agent and the helper (host scenario)', () => {
  let firstKey = ''
  let newKey = ''

  it('adds a staged key to the node; activation waits for the node’s signed statement of trust', async () => {
    firstKey = (await jobKey('list')).body.keys.find(
      (k: { state: string }) => k.state === 'active',
    ).keyId
    const staged = await jobKey('stage')
    expect(staged.code, staged.error).toBe(0)
    newKey = staged.body.changed
    const early = await jobKey('activate')
    expect(early.code).toBe(2)
    expect(early.error).toContain('job_key_trust_unproven')
    const added = await configUpdate({ addJobKeys: [newKey], retireJobKeys: [] })
    expect([added.state, added.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(await trustedKeys()).toEqual([firstKey, newKey].sort())
    expect(await signers(added.id)).toEqual([
      `agent.diagnostics@2 ${firstKey}`,
      `config.update@1 ${firstKey}`,
      `agent.diagnostics@2 ${newKey}`,
    ])
    const twice = await w.call('POST', `/api/v1/nodes/${w.requireNode().nodeId}/config-updates`, {
      addJobKeys: [newKey],
      retireJobKeys: [],
    })
    expect([twice.status, twice.body?.details?.reason]).toEqual([409, 'job_key_not_addable'])
    const statement = await w.sql(
      `SELECT completion -> 'result' -> 'jobKeys' AS agent,
              completion -> 'result' -> 'helperJobKeys' AS helper, node_signature_valid AS valid
         FROM nodes.jobs WHERE operation_id = $1 AND capability = 'agent.diagnostics@2'
        ORDER BY completed_at DESC LIMIT 1`,
      [added.id],
    )
    expect({
      agent: [...(statement[0]?.agent ?? [])].sort(),
      helper: [...(statement[0]?.helper ?? [])].sort(),
      valid: statement[0]?.valid,
    }).toEqual({ agent: [firstKey, newKey].sort(), helper: [firstKey, newKey].sort(), valid: true })
  })

  it('signs with the new key after activation; the helper accepts it for an effect', async () => {
    expect(await jobKey('activate')).toMatchObject({ code: 0 })
    await w.inspect('postgres.status@1')
    const reloaded = await w.planAndApply({ kind: 'postgres.reload' })
    expect([reloaded.state, reloaded.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(new Set((await signers(reloaded.id)).map((x) => x.split(' ')[1]))).toEqual(
      new Set([newKey]),
    )
    // An effect through the helper, signed with the new key.
    const changed = await w.finished(await w.configChange('5MB'))
    expect([changed.state, changed.verificationOutcome]).toEqual(['succeeded', 'passed'])
    expect(new Set((await signers(changed.id)).map((x) => x.split(' ')[1]))).toEqual(
      new Set([newKey]),
    )
  })

  it('keeps the old key for the overlap, then removes it from the node and retires it', async () => {
    const nodeId = w.requireNode().nodeId
    const early = await w.call('POST', `/api/v1/nodes/${nodeId}/config-updates`, {
      addJobKeys: [],
      retireJobKeys: [firstKey],
    })
    expect([early.status, early.body?.details?.reason]).toEqual([409, 'job_key_overlap'])
    await w.db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE nodes.job_keys SET state_changed_at = state_changed_at - interval '8 days' WHERE key_id = $1`,
        [firstKey],
      )
      await c.query('COMMIT')
    })
    const stillTrusted = await jobKey('retire', firstKey)
    expect(stillTrusted.code).toBe(2)
    expect(stillTrusted.error).toContain('job_key_still_trusted')
    const dropped = await configUpdate({ addJobKeys: [], retireJobKeys: [firstKey] })
    expect([dropped.state, dropped.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(await trustedKeys()).toEqual([newKey])
    const retired = await jobKey('retire', firstKey)
    expect(retired.code, retired.error).toBe(0)
    expect(
      Object.fromEntries(
        retired.body.keys.map((k: { keyId: string; state: string }) => [k.keyId, k.state]),
      ),
    ).toMatchObject({ [firstKey]: 'retired', [newKey]: 'active' })
    // The node still works with the remaining key.
    await w.inspect('postgres.status@1')
  })
})
