import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chown, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { NODE_CAPABILITIES } from '@exponetdb/contracts'
import { newId, parseId } from '@exponetdb/kernel'
import { b64u, signJobEnvelope } from '@exponetdb/kernel/node'
import { readSecret } from '@exponetdb/secrets'
import { describe, expect, it } from 'vitest'
import { eventually, hostScenario, run } from '../support/host-world.ts'

/**
 * Host scenario: a job or a configuration that names the wrong node, the
 * wrong installation, the wrong cluster or the wrong path (control-plane.md
 * §9, architecture.md §2), on a node of its own. A faulty or hostile Control
 * Store is simulated by writing the job row itself; the agent verifies the
 * signed envelope and refuses it. A cluster replaced after planning is
 * refused on the host by its system identifier; a configuration the agent
 * user could write, or a fragment the cluster does not include, changes
 * nothing.
 */
const w = hostScenario({ scenario: 'identity' })

/** Inserts a signed job for this node directly, as a faulty Control Store would. */
async function forgedJob(options: { nodeIdInEnvelope: string; seed?: Uint8Array; keyId?: string }) {
  const node = w.requireNode()
  const operationId = newId('op', Date.now())
  await w.sql(
    `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                        actor_kind, client_kind)
     VALUES ($1, 'node.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
    [operationId],
  )
  let keyId = options.keyId
  let seed = options.seed
  if (seed === undefined) {
    const key = await w.sql(`SELECT key_id, secret_id FROM nodes.job_keys WHERE state = 'active'`)
    const secretId = parseId('sec', String(key[0]?.secret_id))
    if (!secretId.ok) throw new Error('job key secret')
    seed = await readSecret(w.worker, w.keyring, {
      secretId: secretId.value,
      consumer: 'worker',
    })
    keyId = String(key[0]?.key_id)
  }
  const now = Date.now()
  const jobId = newId('job', now)
  const definition = NODE_CAPABILITIES['agent.diagnostics@2']
  const args = {}
  const { createHash } = await import('node:crypto')
  const nonce = b64u(new Uint8Array(randomBytes(16)))
  const issuedAt = new Date(now).toISOString()
  const envelope = {
    jobId,
    operationId,
    nodeId: options.nodeIdInEnvelope,
    capability: { name: definition.name, major: definition.major },
    args,
    argsHash: `sha256:${createHash('sha256').update('{}').digest('hex')}`,
    notBefore: issuedAt,
    expiresAt: new Date(now + 900_000).toISOString(),
    nonce,
    issuedAt,
    attempt: 1,
  }
  const signed = signJobEnvelope(envelope, keyId ?? 'k2026x', seed)
  const insert = `INSERT INTO nodes.jobs (job_id, node_id, operation_id, capability, envelope, args_hash, nonce,
                             not_before, expires_at, run_seconds, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`
  const values = [
    jobId,
    node.nodeId,
    operationId,
    'agent.diagnostics@2',
    JSON.stringify(signed),
    envelope.argsHash,
    nonce,
    new Date(now),
    new Date(now + 900_000),
    definition.runSeconds,
  ]
  if (options.nodeIdInEnvelope === node.nodeId) {
    await w.sql(insert, values)
  } else {
    // The Control Store refuses a job whose columns are not its envelope's
    // (a guard trigger); only a compromised store, writing with its triggers
    // disabled, could hand the node such a job. The agent refuses it too.
    await expect(w.sql(insert, values)).rejects.toThrow("a job's columns are its signed envelope's")
    await w.db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      // Without the trigger, the columns it fills are given here.
      await c.query(
        `INSERT INTO nodes.jobs (job_id, node_id, operation_id, capability, envelope, args_hash, nonce,
                                 not_before, expires_at, run_seconds, state, created_at, state_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', clock_timestamp(), clock_timestamp())`,
        values,
      )
      await c.query('COMMIT')
    })
  }
  return jobId
}

async function jobEnd(jobId: string) {
  const rows = await eventually(
    `job ${jobId} to end`,
    () =>
      w.sql(
        `SELECT state, outcome, node_signature_valid, completion FROM nodes.jobs WHERE job_id = $1`,
        [jobId],
      ),
    (r) => r[0]?.state !== 'pending' && r[0]?.state !== 'claimed' && r[0]?.state !== 'running',
    120_000,
  )
  return rows[0]
}

describe('the wrong node, installation, cluster or path (host scenario)', () => {
  it('a job naming another node is refused by the agent (node_mismatch); nothing runs', async () => {
    await w.inspect('postgres.status@1')
    const mark = w.logMark()
    const jobId = await forgedJob({ nodeIdInEnvelope: newId('nod', Date.now()) })
    const end = await jobEnd(jobId)
    // A signed rejection: no step ran, no result, the reason named.
    expect([end?.state, end?.outcome, end?.completion?.rejectionReason]).toEqual([
      'completed',
      'rejected',
      'node_mismatch',
    ])
    expect([end?.completion?.steps, end?.completion?.result]).toEqual([[], null])
    expect(await w.logs(mark)).toContain('"reason":"node_mismatch"')
  })

  it('a job signed by a key this node does not trust (another installation’s) is refused; nothing runs', async () => {
    const mark = w.logMark()
    const jobId = await forgedJob({
      nodeIdInEnvelope: w.requireNode().nodeId,
      seed: new Uint8Array(randomBytes(32)),
      keyId: 'k2026z',
    })
    const end = await jobEnd(jobId)
    expect([end?.state, end?.outcome, end?.completion?.rejectionReason]).toEqual([
      'completed',
      'rejected',
      'unknown_signing_key',
    ])
    expect([end?.completion?.steps, end?.completion?.result]).toEqual([[], null])
    expect(await w.logs(mark)).toContain('"reason":"unknown_signing_key"')
  })

  it('a configuration the agent user could write is refused by the helper', async () => {
    const node = w.requireNode()
    const writable = join(w.dir, 'writable-config.json')
    await writeFile(writable, JSON.stringify({ schema: 'exponetdb.node-config/v1' }), {
      mode: 0o644,
    })
    await chown(writable, node.uid, node.gid)
    const refused = await run(
      join(w.dir, 'exponetdb-node-helper'),
      [
        'serve',
        '--config',
        writable,
        '--trust',
        node.trustPath,
        '--state-dir',
        join(node.helperDir, 'other-state'),
      ],
      { env: w.agentEnv, timeout: 30_000 },
    ).then(
      () => ({ ok: true, stderr: '' }),
      (e: { stderr?: string }) => ({ ok: false, stderr: e.stderr ?? '' }),
    )
    expect(refused.ok).toBe(false)
    expect(refused.stderr).toContain(
      `configuration: ${writable} is owned by uid ${node.uid}, not 0`,
    )
    expect(existsSync(join(node.helperDir, 'other-state'))).toBe(false)
    await rm(writable)
  })

  it('a managed fragment the cluster does not include: the plan is refused and the file never created', async () => {
    const node = w.requireNode()
    const original = readFileSync(node.configPath, 'utf8')
    const config = JSON.parse(original)
    const elsewhere = join(dirname(w.instance.configFile), 'exdb-not-included.conf')
    config.instances[0].managedInclude = elsewhere
    await w.stopAgent()
    await w.stopHelper()
    await writeFile(node.configPath, JSON.stringify(config), { mode: 0o644 })
    await w.startHelper()
    await w.startAgent()
    try {
      const changes = [{ name: 'work_mem', value: '22MB' }]
      await w.inspect('postgres.config.plan@2', { changes })
      const planned = await w.plan({ kind: 'postgres.config.apply', changes, reload: true })
      expect([planned.status, planned.body?.code]).toEqual([409, 'CONFLICT'])
      expect(existsSync(elsewhere)).toBe(false)
    } finally {
      await w.stopAgent()
      await w.stopHelper()
      await writeFile(node.configPath, original, { mode: 0o644 })
      await w.startHelper()
      await w.startAgent()
    }
    await w.inspect('postgres.status@1')
  })

  it('a cluster replaced after planning: the plan is stale at apply; nothing reaches the new cluster', async () => {
    const changes = [{ name: 'work_mem', value: '21MB' }]
    await w.inspect('postgres.config.plan@2', { changes })
    const planned = await w.plan({ kind: 'postgres.config.apply', changes, reload: true })
    expect(planned.status).toBe(201)
    // The disposable cluster is recreated at the same path and port: a new system identifier.
    await w.stopAgent()
    await w.stopHelper()
    const out = join(w.dir, 'replaced')
    await run(
      'bash',
      [
        join(
          dirname(new URL(import.meta.url).pathname),
          '../../../../tooling/dev/node-clusters.sh',
        ),
        out,
      ],
      {
        env: {
          ...process.env,
          EXDB_NODE_PG_VERSIONS: '17',
          EXDB_NODE_AGENT_USER: `root ${w.agentUser}`,
        },
      },
    )
    const replaced = await w.psql('SELECT system_identifier FROM pg_control_system()')
    expect(replaced).not.toBe(w.systemIdentifier)
    await w.startHelper()
    await w.startAgent()
    // The server knows the node's clusters from its last hello: until the restarted agent
    // has reported the new system identifier, the old one is still listed and an apply is
    // rightly accepted. The scenario is about a replacement the server knows of.
    await eventually(
      'the node to report the replaced cluster',
      () => w.sql('SELECT clusters FROM nodes.nodes WHERE node_id = $1', [w.requireNode().nodeId]),
      (rows) => JSON.stringify(rows).includes(replaced),
    )
    await w.reauth()
    const applied = await w.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    // The node reports the new cluster's system identifier; the registry pins the old one.
    expect([applied.status, applied.body?.code, applied.body?.details?.changedBindings]).toEqual([
      409,
      'PLAN_STALE',
      [{ binding: 'node', actual: 'registry_conflict' }],
    ])
    expect(existsSync(w.instance.managedInclude)).toBe(false)
    expect(await w.psql('SHOW work_mem')).toBe('4MB')
  })
})
