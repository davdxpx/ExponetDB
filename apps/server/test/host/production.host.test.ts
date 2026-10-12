import { describe, expect, it } from 'vitest'
import { hostScenario } from '../support/host-world.ts'

/**
 * Host scenario: the production boundary and the critical class (Wave 5
 * correction F2, G6 finding A2), on a node of its own. A critical role
 * change is never a machine's, on any tier: the service account's plan is
 * refused at apply and nothing reaches the host. A production target makes
 * the cluster production: a reload waits for a human approval, the agent
 * gets no job before it, and runs it after.
 */
const w = hostScenario({ scenario: 'production' })

describe('production approval and the critical class (host scenario)', () => {
  it('refuses a critical role change applied by a machine, on a nonprod cluster too', async () => {
    const account = await w.serviceAccount('Automation', 'operator')
    const key = await w.apiKey(
      account,
      ['nodes.read', 'nodes.plan', 'nodes.operate:nonprod'],
      ['nonprod'],
    )
    const nodeId = w.requireNode().nodeId
    // The basis read, by the machine itself.
    const read = await w.bearer(key, `/api/v1/nodes/${nodeId}/inspections`, 'POST', {
      capability: 'postgres.roles.inspect@2',
      clusterId: w.clusterId,
      args: { expectSettings: [] },
    })
    expect(read.status, JSON.stringify(read.body)).toBe(202)
    expect((await w.finished(read.body.id)).state).toBe('succeeded')
    const role = `exdb_critical_${w.runTag}`
    const planned = await w.bearer(key, `/api/v1/nodes/${nodeId}/plans`, 'POST', {
      clusterId: w.clusterId,
      change: {
        kind: 'postgres.roles.apply',
        steps: [
          {
            op: 'create_role',
            role,
            attributes: {
              login: false,
              inherit: true,
              createdb: false,
              createrole: true,
              replication: false,
              bypassrls: false,
              connectionLimit: -1,
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
        ],
      },
    })
    expect([planned.status, planned.body?.class], JSON.stringify(planned.body)).toEqual([
      201,
      'critical',
    ])
    const applied = await w.bearer(key, `/api/v1/plans/${planned.body.id}/apply`, 'POST', {})
    expect([applied.status, applied.body?.code]).toEqual([403, 'PERMISSION_DENIED'])
    expect(
      await w.sql(`SELECT count(*)::int AS n FROM operations.operations WHERE plan_id = $1`, [
        planned.body.id,
      ]),
    ).toEqual([{ n: 0 }])
    expect(await w.psql(`SELECT count(*) FROM pg_roles WHERE rolname = '${role}'`)).toBe('0')
  })

  it('holds a production reload for a human approval; no job before it, run after', async () => {
    await w.placeProduction()
    await w.inspect('postgres.status@1')
    const prodPlan = await w.plan({ kind: 'postgres.reload' })
    expect(prodPlan.body.requirements).toEqual([
      { kind: 'approval', count: 1, permission: 'plans.approve' },
    ])
    const awaiting = await w.call('POST', `/api/v1/plans/${prodPlan.body.id}/apply`, {})
    expect(awaiting.body).toMatchObject({ state: 'awaiting_approval' })
    // The worker never claims an operation awaiting approval (it polls every 2 s).
    await new Promise((r) => setTimeout(r, 5000))
    expect(
      await w.sql('SELECT count(*)::int AS n FROM nodes.jobs WHERE operation_id = $1', [
        awaiting.body.id,
      ]),
    ).toEqual([{ n: 0 }])
    await w.reauth()
    const approved = await w.call('POST', `/api/v1/approvals/${awaiting.body.id}/approve`, {
      planHash: prodPlan.body.planHash,
      acknowledgeSelfApproval: true,
    })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    const done = await w.finished(awaiting.body.id)
    expect([done.state, done.verificationOutcome], w.lines.join('')).toEqual([
      'succeeded',
      'passed',
    ])
  })
})
