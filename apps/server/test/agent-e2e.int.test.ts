import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId } from '@exponetdb/kernel'
import { createEnrollmentToken, createJob, revealEnrollmentToken } from '@exponetdb/nodes'
import { generateKeyringText, parseKeyring } from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCommand } from '../src/commands/index.ts'
import type { GatewayConfig, WorkerConfig } from '../src/config/env.ts'
import { runGateway, runWorker } from '../src/roles/roles.ts'

/**
 * End to end (G5 record, Phase 3): the real Go agent (`exponetdb-node`,
 * built here with the e2e test seams only: a test-owned configuration and a
 * clock assumed synchronized) against the real gateway and worker roles and
 * PostgreSQL 17. The agent enrolls with a revealed token over HTTP/2 mTLS,
 * the worker binds it, a signed job runs and its completion verifies, a
 * renewal is observed, and a revoked node is refused at its next request.
 */

const run = promisify(execFile)
const AGENT_DIR = fileURLToPath(new URL('../../../agent/node/', import.meta.url))
const SERVER_NAME = 'gateway.exdb.test'
const keyringText = generateKeyringText('k2026a')

let db: MigratedTestDatabase
let dir = ''
let agentBinary = ''
let worker: ControlStore
let serve: ControlStore
const stops: (() => Promise<unknown>)[] = []

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_agent')
  dir = await mkdtemp(join(tmpdir(), 'exdb-agent-'))
  agentBinary = join(dir, 'exponetdb-node')
  await run('go', ['build', '-tags', 'e2e', '-o', agentBinary, './cmd/exponetdb-node'], {
    cwd: AGENT_DIR,
  })
  worker = db.store('exdb_worker')
  serve = db.store('exdb_serve')
}, 180_000)

afterAll(async () => {
  for (const stop of stops.reverse()) {
    await stop().catch(() => undefined)
  }
  await db?.drop()
  await rm(dir, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      s.close(() => done(port))
    })
  })
}

async function eventually<T>(
  what: string,
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (ok(v)) {
      return v
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)}`)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

const sql = async (text: string, params: unknown[] = []) =>
  (await db.asSuperuser((c) => c.query(text, params))).rows

function startRole(
  runner: (hooks: { until: Promise<unknown>; write: () => void }) => Promise<number>,
) {
  let release: () => void = () => undefined
  const until = new Promise<void>((r) => {
    release = r
  })
  const exit = runner({ until, write: () => undefined })
  stops.push(async () => {
    release()
    return exit
  })
}

describe('the Go agent against the gateway and the worker', () => {
  it('enrolls, is bound, runs a signed job, renews, and is refused once revoked', async () => {
    const port = await freePort()
    // The ceremony, with the gateway URL the token will carry.
    const ceremony = await runCommand(
      [
        'node-pki',
        'init',
        '--gateway-url',
        `https://127.0.0.1:${port}`,
        '--server-name',
        SERVER_NAME,
        '--root-key-out',
        join(dir, 'root-key.pem'),
      ],
      {
        env: { EXPONETDB_CONTROL_STORE_URL: db.url('exdb_worker'), EXPONETDB_KEYRING: keyringText },
        stdout: () => undefined,
        stderr: () => undefined,
      },
    )
    expect(ceremony).toBe(0)

    const common = {
      logLevel: 'warn' as const,
      otlpEndpoint: undefined,
      internalListen: { host: '127.0.0.1', port: 0 },
      shutdownTimeoutMs: 10_000,
      keyringEnv: { EXPONETDB_KEYRING: keyringText },
      installationId: db.installationId,
    }
    const gatewayConfig: GatewayConfig = {
      ...common,
      role: 'gateway',
      controlStoreUrl: db.url('exdb_gateway'),
      agentListen: { host: '127.0.0.1', port },
    }
    const workerConfig: WorkerConfig = {
      ...common,
      role: 'worker',
      controlStoreUrl: db.url('exdb_worker'),
      auditExport: { kind: 'none' },
    }
    startRole((hooks) => runGateway(gatewayConfig, hooks))
    startRole((hooks) => runWorker(workerConfig, hooks))
    await eventually(
      'the agent listener',
      () =>
        new Promise<boolean>((done) => {
          const socket = connect(port, '127.0.0.1')
          socket.once('connect', () => {
            socket.destroy()
            done(true)
          })
          socket.once('error', () => done(false))
        }),
      (open) => open,
    )

    // The applying identity's token (node.enroll's two steps, control-plane.md §4).
    const parsed = parseKeyring(keyringText)
    if (!parsed.ok) {
      throw new Error('keyring')
    }
    const keyring = parsed.value
    const op = newId('op', Date.now())
    await sql(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'node.enroll', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [op],
    )
    const serverId = newId('srv', Date.now())
    await worker.query(
      'test.server',
      `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
       VALUES ($1, 'db host', 'other', '{}', $2)`,
      [serverId, op],
    )
    const tokenId = newId('ent', Date.now())
    const identityId = newId('idn', Date.now())
    const clock = { nowMs: () => Date.now() }
    await worker.transaction('test.token', (tx) =>
      createEnrollmentToken(tx, clock, {
        tokenId,
        serverId,
        revealBy: identityId,
        operationId: op,
      }),
    )
    const revealed = await serve.transaction('test.reveal', (tx) =>
      revealEnrollmentToken(tx, keyring, clock, {
        tokenId,
        identityId,
        installationId: db.installationId,
      }),
    )

    // The host: a private state directory and a configuration of the test user.
    const state = join(dir, 'state')
    await mkdir(state, { mode: 0o700 })
    await chmod(state, 0o700)
    const configPath = join(dir, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        schema: 'exponetdb.node-config/v1',
        stateDirectory: state,
        helperSocket: '/run/exponetdb-node/helper.sock',
        disabledCapabilities: [],
        instances: [],
      }),
      { mode: 0o644 },
    )
    const tokenPath = join(dir, 'token')
    await writeFile(tokenPath, `${revealed.token}\n`, { mode: 0o600 })
    const env = {
      ...process.env,
      EXPONETDB_NODE_E2E_CONFIG_UID: String(process.getuid?.() ?? 0),
      EXPONETDB_NODE_E2E_CLOCK: 'synchronized',
    }
    const enrolled = await run(
      agentBinary,
      ['enroll', '--config', configPath, '--token-file', tokenPath],
      {
        env,
      },
    )
    expect(enrolled.stdout).toMatch(/^enrolled as nod_/)
    const nodeId = /enrolled as (nod_[0-9A-Z]{26})/.exec(enrolled.stdout)?.[1] ?? ''
    // A second enrollment with the same token is refused (the token is spent).
    await expect(
      run(agentBinary, ['enroll', '--config', join(dir, 'other.json'), '--token-file', tokenPath], {
        env,
      }),
    ).rejects.toThrow()

    const logs: string[] = []
    const agent: ChildProcess = spawn(agentBinary, ['run', '--config', configPath], { env })
    agent.stderr?.on('data', (c: Buffer) => logs.push(c.toString('utf8')))
    stops.push(async () => {
      agent.kill('SIGTERM')
    })

    // The worker binds the node; the agent says hello.
    await eventually(
      'binding and hello',
      () =>
        sql('SELECT state, last_hello_at, agent_version FROM nodes.nodes WHERE node_id = $1', [
          nodeId,
        ]),
      (rows) => rows[0]?.state === 'active' && rows[0]?.last_hello_at !== null,
    )

    // A signed job runs once; its completion carries a valid node signature.
    const jobOp = newId('op', Date.now())
    await sql(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'node.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [jobOp],
    )
    const job = await worker.transaction('test.job', (tx) =>
      createJob(tx, keyring, clock, db.installationId, {
        nodeId,
        operationId: jobOp,
        capability: 'agent.diagnostics@1',
        args: () => ({}),
      }),
    )
    const judged = await eventually(
      'the judged completion',
      () =>
        sql(
          'SELECT state, outcome, node_signature_valid, completion FROM nodes.jobs WHERE job_id = $1',
          [job.jobId],
        ),
      (rows) =>
        rows[0]?.node_signature_valid !== null && rows[0]?.node_signature_valid !== undefined,
    )
    expect(judged[0]).toMatchObject({
      state: 'completed',
      outcome: 'succeeded',
      node_signature_valid: true,
    })
    expect(judged[0].completion.result.agentVersion).toMatch(/^\d+\.\d+\.\d+/)

    // Renewal: with a third of the lifetime left, the gateway instructs it.
    const before = await sql('SELECT certificate FROM nodes.nodes WHERE node_id = $1', [nodeId])
    await sql(
      `UPDATE nodes.nodes SET certificate_expires_at = clock_timestamp() + interval '1 hour' WHERE node_id = $1`,
      [nodeId],
    )
    const renewed = await eventually(
      'a renewal',
      () =>
        sql(
          'SELECT certificate, certificate_renewed_at, previous_certificate FROM nodes.nodes WHERE node_id = $1',
          [nodeId],
        ),
      (rows) => rows[0]?.certificate_renewed_at !== null && rows[0]?.previous_certificate === null,
      90_000,
    )
    expect(Buffer.compare(renewed[0].certificate, before[0].certificate)).not.toBe(0)
    const renewalAudit = await sql(
      `SELECT action FROM audit.audit_events WHERE event::jsonb->'subject'->>'nodeId' = $1`,
      [nodeId],
    )
    expect(renewalAudit.map((r) => r.action)).toEqual(
      expect.arrayContaining(['node.enrolled', 'node.bound', 'node.certificate_renewed']),
    )

    // Revocation: the gateway refuses the node at its next request.
    const revoke = newId('op', Date.now())
    await sql(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'node.revoke', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [revoke],
    )
    const revokedAt = Date.now()
    await worker.query(
      'test.revoke',
      `UPDATE nodes.nodes SET state = 'revoked', state_changed_by_operation_id = $2, state_reason = 'test' WHERE node_id = $1`,
      [nodeId, revoke],
    )
    await eventually(
      'the refusal',
      async () => logs.join(''),
      (text) => text.includes('NODE_CERTIFICATE_REFUSED'),
      20_000,
    )
    expect(Date.now() - revokedAt).toBeLessThan(20_000)
    const last = await sql('SELECT last_heartbeat_at FROM nodes.nodes WHERE node_id = $1', [nodeId])
    await new Promise((r) => setTimeout(r, 3_000))
    const later = await sql('SELECT last_heartbeat_at FROM nodes.nodes WHERE node_id = $1', [
      nodeId,
    ])
    expect(later[0].last_heartbeat_at).toEqual(last[0].last_heartbeat_at)
    // Nothing the agent logged carries the token or key material.
    expect(logs.join('')).not.toContain(revealed.token.slice(7, 47))
  }, 300_000)
})
