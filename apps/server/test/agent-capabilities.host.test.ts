import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { createEnrollmentToken, revealEnrollmentToken } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import { generateKeyringText, type Keyring, parseKeyring } from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { runCommand } from '../src/commands/index.ts'
import { composeAccess } from '../src/composition/access.ts'
import type { GatewayConfig, ServeConfig, WorkerConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import { runGateway, runWorker } from '../src/roles/roles.ts'

/**
 * Capability operations end to end (control-plane.md §9, G5 items 2, 3 and
 * 7): REST plans and inspections of a person, the real gateway and worker
 * roles, the Go agent (`exponetdb-node`, e2e build: a clock assumed
 * synchronized) running as an unprivileged OS user, the root helper
 * (`exponetdb-node-helper`, e2e build with the same clock seam), and a
 * disposable PostgreSQL 17 cluster in the Debian layout
 * (tooling/dev/node-clusters.sh). Observations are node-signed; every change
 * is planned against one, applied by signed jobs and verified by a separate
 * read.
 *
 * A host test (vitest.host.config.ts): needs root (the helper),
 * EXDB_NODE_CLUSTERS and EXDB_NODE_E2E_AGENT_USER (an OS user the clusters
 * map to exponetdb_node) and fails without them; CI runs it in the job that
 * creates those clusters (node-pg). The restart and the failed-unit read run
 * only on a host with systemd as PID 1.
 */

const CLUSTERS = process.env['EXDB_NODE_CLUSTERS']
const AGENT_USER = process.env['EXDB_NODE_E2E_AGENT_USER']
const SYSTEMD = existsSync('/run/systemd/system')

const run = promisify(execFile)
const AGENT_DIR = fileURLToPath(new URL('../../../agent/node/', import.meta.url))
const ORIGIN = 'https://db.example.test'
const RP_ID = 'db.example.test'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36'
const PASSWORD = 'tangerine fjord radiator 42'
const SERVER_NAME = 'gateway.exdb.test'
const PG_NAME = 'pg17.exdb.test'
const keyringText = generateKeyringText('k2026c')

interface Instance {
  readonly localName: string
  readonly port: number
  readonly socketDirectory: string
  readonly dataDirectory: string
  readonly configFile: string
  readonly hbaFile: string
  readonly managedInclude: string
  readonly unit: string
  readonly tlsCertificateFile: string
  readonly tlsKeyFile: string
}

let db: MigratedTestDatabase
let dir = ''
let keyring: Keyring
let worker: ControlStore
let app: ReturnType<typeof createPublicApp>
let owner: { browser: Browser; authenticator: SoftAuthenticator }
let caPem = ''
let instance: Instance
const stops: (() => Promise<unknown>)[] = []

const sql = async (text: string, params: unknown[] = []) =>
  (await db.asSuperuser((c) => c.query(text, params))).rows

async function psql(query: string, database = 'postgres'): Promise<string> {
  const { stdout } = await run('runuser', [
    '-u',
    'postgres',
    '--',
    'psql',
    '-X',
    '-q',
    '-A',
    '-t',
    '-p',
    String(instance.port),
    '-d',
    database,
    '-c',
    query,
  ])
  return stdout.trim()
}

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
  ms = 90_000,
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

class Browser {
  readonly jar = new Map<string, string>()

  async call(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { 'user-agent': UA }
    if (this.jar.size > 0) {
      headers['cookie'] = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
    }
    if (method !== 'GET') {
      headers['origin'] = ORIGIN
      const csrf = this.jar.get('__Host-exdb_csrf')
      if (csrf !== undefined) headers['x-csrf-token'] = csrf
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const response = await app.request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const index = (pair ?? '').indexOf('=')
      const name = (pair ?? '').slice(0, index)
      if (/max-age=0/i.test(line)) this.jar.delete(name)
      else this.jar.set(name, (pair ?? '').slice(index + 1))
    }
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
  }
}

async function enrollOwner() {
  const issued = await bootstrapOwner(
    {
      store: db.store('exdb_serve'),
      clock: systemClock,
      config: { publicOrigin: ORIGIN, rpId: RP_ID, rpName: 'ExponetDB' },
      channel: undefined,
    },
    { email: 'owner@example.test', reissue: false },
  )
  const browser = new Browser()
  const token = new URL(issued.link).hash.replace('#token=', '')
  expect((await browser.call('POST', '/auth/enrollment/redeem', { token })).status).toBe(200)
  const options = await browser.call('POST', '/auth/enrollment/passkey/options', {})
  const authenticator = new SoftAuthenticator(
    new Uint8Array(Buffer.from(options.body.user.id, 'base64url')),
  )
  const credential = authenticator.register({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  await browser.call('POST', '/auth/enrollment/passkey', { credential, label: 'Laptop' })
  await browser.call('POST', '/auth/enrollment/password', { password: PASSWORD })
  const setup = await browser.call('POST', '/auth/enrollment/totp/options', {})
  const secret = Secret.fromBase32(setup.body.secret).bytes
  await browser.call('POST', '/auth/enrollment/totp', { code: totpCodeAt(secret, Date.now()) })
  expect((await browser.call('POST', '/auth/enrollment/complete', {})).status).toBe(200)
  return { browser, authenticator }
}

async function reauth() {
  const options = await owner.browser.call('POST', '/auth/reauth/passkey/options', {})
  const credential = owner.authenticator.assert({
    challenge: options.body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  })
  expect((await owner.browser.call('POST', '/auth/reauth/passkey', { credential })).status).toBe(
    200,
  )
}

/**
 * Waits for an operation to end and returns its outcome, read from the
 * Control Store (`GET /operations/{id}` is not served yet).
 */
async function finished(operationId: string) {
  const read = async () => {
    const rows = await sql(
      `SELECT o.operation_id AS id, o.state, o.apply_outcome, o.verification_outcome,
              (SELECT e.detail->>'errorCode' FROM operations.operation_events e
                WHERE e.operation_id = o.operation_id AND e.detail ? 'errorCode'
                ORDER BY e.event_id DESC LIMIT 1) AS error_code
         FROM operations.operations o WHERE o.operation_id = $1`,
      [operationId],
    )
    const r = rows[0]
    return r === undefined
      ? undefined
      : {
          id: r.id as string,
          state: r.state as string,
          applyOutcome: r.apply_outcome as string,
          verificationOutcome: r.verification_outcome as string,
          errorCode: (r.error_code ?? null) as string | null,
        }
  }
  return eventually(
    `operation ${operationId}`,
    read,
    (op) =>
      op !== undefined &&
      ['succeeded', 'failed', 'verification_failed', 'needs_attention', 'canceled'].includes(
        op.state,
      ),
    180_000,
  ) as Promise<{
    id: string
    state: string
    applyOutcome: string
    verificationOutcome: string
    errorCode: string | null
  }>
}

beforeAll(async () => {
  if (CLUSTERS === undefined || AGENT_USER === undefined || process.getuid?.() !== 0) {
    throw new Error(
      'host test: run as root with EXDB_NODE_CLUSTERS (tooling/dev/node-clusters.sh) and EXDB_NODE_E2E_AGENT_USER (an unprivileged OS user the clusters map to exponetdb_node)',
    )
  }
  const instances = JSON.parse(readFileSync(CLUSTERS ?? '', 'utf8')) as Instance[]
  const found = instances.find((i) => i.localName.startsWith('17/'))
  if (found === undefined) {
    throw new Error('EXDB_NODE_CLUSTERS has no PostgreSQL 17 instance')
  }
  instance = found
  db = await migratedTestDatabase('exdb_it_agent_capabilities')
  // Outside /tmp: under systemd the units have a private /tmp.
  dir = await mkdtemp('/var/lib/exdb-host-test-')
  await chmod(dir, 0o755)
  await Promise.all([
    run(
      'go',
      ['build', '-tags', 'e2e', '-o', join(dir, 'exponetdb-node'), './cmd/exponetdb-node'],
      {
        cwd: AGENT_DIR,
      },
    ),
    run(
      'go',
      [
        'build',
        '-tags',
        'e2e',
        '-o',
        join(dir, 'exponetdb-node-helper'),
        './cmd/exponetdb-node-helper',
      ],
      { cwd: AGENT_DIR },
    ),
  ])
  const parsed = parseKeyring(keyringText)
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  worker = db.store('exdb_worker')
}, 300_000)

afterAll(async () => {
  for (const stop of stops.reverse()) {
    await stop().catch(() => undefined)
  }
  await db?.drop()
  if (dir !== '') {
    await rm(dir, { recursive: true, force: true })
  }
})

const UNITS = fileURLToPath(new URL('../../../agent/node/packaging/systemd/', import.meta.url))
const PREFIX = 'exdb-host-test'

/** Replaces exactly one match, so the test fails when the shipped unit changes shape. */
function swap(text: string, pattern: RegExp, replacement: string): string {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))
  if (matches?.length !== 1) {
    throw new Error(`unit: expected one ${pattern} in the shipped unit`)
  }
  return text.replace(pattern, replacement)
}

/** Installs the shipped units under /run/systemd/system with this test's paths and starts them. */
async function startUnits(p: {
  readonly group: string
  readonly configPath: string
  readonly trustPath: string
  readonly helperDir: string
  readonly state: string
}) {
  const clock = '[Service]\nEnvironment=EXPONETDB_NODE_E2E_CLOCK=synchronized'
  const socketName = `${PREFIX}-helper.socket`
  let agent = readFileSync(join(UNITS, 'exponetdb-node.service'), 'utf8')
  agent = swap(agent, /^User=exponetdb-node$/m, `User=${AGENT_USER}`)
  agent = swap(agent, /^Group=exponetdb-node$/m, `Group=${p.group}`)
  agent = swap(
    agent,
    /^ExecStart=.*$/m,
    `ExecStart=${dir}/exponetdb-node run --config ${p.configPath}`,
  )
  agent = swap(agent, /^StateDirectory=.*\n/m, `ReadWritePaths=${p.state}\n`)
  agent = swap(agent, /^StateDirectoryMode=.*\n/m, '')
  agent = swap(agent, /^\[Service\]$/m, clock).replaceAll(
    'exponetdb-node-helper.socket',
    socketName,
  )
  let socket = readFileSync(join(UNITS, 'exponetdb-node-helper.socket'), 'utf8')
  socket = swap(socket, /^ListenStream=.*$/m, `ListenStream=${dir}/run/helper.sock`)
  socket = swap(socket, /^SocketGroup=.*$/m, `SocketGroup=${p.group}`)
  let helper = readFileSync(join(UNITS, 'exponetdb-node-helper.service'), 'utf8')
  helper = swap(
    helper,
    /^ExecStart=.*$/m,
    `ExecStart=${dir}/exponetdb-node-helper serve --config ${p.configPath} --trust ${p.trustPath} --state-dir ${p.helperDir}/state`,
  )
  helper = swap(helper, /^ReadWritePaths=.*$/m, `ReadWritePaths=/etc/postgresql ${p.helperDir}`)
  helper = swap(helper, /^StateDirectory=.*\n/m, '')
  helper = swap(helper, /^StateDirectoryMode=.*\n/m, '')
  helper = swap(helper, /^\[Service\]$/m, clock).replaceAll(
    'exponetdb-node-helper.socket',
    socketName,
  )
  await writeFile(`/run/systemd/system/${PREFIX}-node.service`, agent)
  await writeFile(`/run/systemd/system/${PREFIX}-helper.service`, helper)
  await writeFile(`/run/systemd/system/${socketName}`, socket)
  stops.push(async () => {
    await run('systemctl', [
      'stop',
      `${PREFIX}-node.service`,
      `${PREFIX}-helper.service`,
      socketName,
    ]).catch(() => undefined)
    for (const unit of [`${PREFIX}-node.service`, `${PREFIX}-helper.service`, socketName]) {
      await rm(`/run/systemd/system/${unit}`, { force: true })
    }
    await run('systemctl', ['daemon-reload'])
  })
  await run('systemctl', ['daemon-reload'])
  await run('systemctl', ['start', socketName])
  await run('systemctl', ['start', `${PREFIX}-node.service`])
}

async function unitLogs(): Promise<string> {
  const { stdout } = await run('journalctl', [
    '--no-pager',
    '-o',
    'cat',
    '-u',
    `${PREFIX}-node.service`,
    '-u',
    `${PREFIX}-helper.service`,
  ])
  return stdout
}

describe('capability operations through the Go agent and the helper', () => {
  it('inspects, plans, applies and verifies configuration, pg_hba, roles, extensions, TLS and a credential rotation', async () => {
    onTestFailed(async () => {
      if (SYSTEMD) {
        console.error(await unitLogs().catch((e: unknown) => String(e)))
      }
    })
    const port = await freePort()
    const commandEnv = {
      EXPONETDB_CONTROL_STORE_URL: db.url('exdb_worker'),
      EXPONETDB_KEYRING: keyringText,
    }
    const out: string[] = []
    const io = { env: commandEnv, stdout: (t: string) => out.push(t), stderr: () => undefined }
    expect(
      await runCommand(
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
        io,
      ),
    ).toBe(0)
    out.length = 0
    expect(await runCommand(['node-pki', 'postgres-ca'], io)).toBe(0)
    const ca = JSON.parse(out.join(''))
    expect(ca.created).toBe(true)
    caPem = ca.certificatePem
    out.length = 0
    expect(await runCommand(['node-pki', 'postgres-ca'], io)).toBe(0)
    expect(JSON.parse(out.join(''))).toMatchObject({ created: false, fingerprint: ca.fingerprint })

    // serve (in process, REST), gateway and worker roles.
    const serveConfig: ServeConfig = {
      role: 'serve',
      logLevel: 'warn',
      otlpEndpoint: undefined,
      controlStoreUrl: db.url('exdb_serve'),
      installationId: db.installationId,
      keyringEnv: {},
      internalListen: { host: '127.0.0.1', port: 0 },
      shutdownTimeoutMs: 10_000,
      listen: { host: '127.0.0.1', port: 0 },
      publicUrl: ORIGIN,
      webauthnRpId: undefined,
      trustedProxies: [],
      egressAddresses: [],
    }
    const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
    const access = composeAccess(
      serveConfig,
      { store: db.store('exdb_serve'), keyring },
      { clock: systemClock },
    )
    expect((await access.roleCatalogCheck.run()).status).toBe('pass')
    expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
    app = createPublicApp(
      {
        readiness: () => ({ status: 'ready', evaluatedAt: new Date().toISOString(), checks: [] }),
        version: '0.0.0-test',
        logger,
        metrics: httpMetrics(new MetricsRegistry()),
        clock: systemClock,
      },
      {
        api: {
          application: access.application,
          publicOrigin: ORIGIN,
          trustedProxies: [],
          logger,
          available: access.available,
        },
      },
    )
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
    owner = await enrollOwner()

    // The registry: a server and its agent-managed cluster, pinned to the
    // instance's system identifier, whose CA bundle trusts the PostgreSQL CA.
    const op = newId('op', Date.now())
    await sql(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'registry.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [op],
    )
    const serverId = newId('srv', Date.now())
    const clusterId = newId('cls', Date.now())
    const systemIdentifier = await psql('SELECT system_identifier FROM pg_control_system()')
    await worker.query(
      'test.server',
      `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
       VALUES ($1, 'db host', 'other', '{}', $2)`,
      [serverId, op],
    )
    await sql(
      `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle, created_by_operation_id)
       VALUES ($1, $2, 'agent', 'main', 'pending', $3, $4)`,
      [clusterId, serverId, caPem, op],
    )
    await sql(
      `UPDATE registry.clusters SET state = 'active', system_identifier = $2, server_version_num = 170000,
              confirmed_by_operation_id = $3 WHERE cluster_id = $1`,
      [clusterId, systemIdentifier, op],
    )
    await sql(
      `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, host, port, tls_server_name, label, state, created_at,
                                       created_by_operation_id)
       VALUES ($1, $2, 'private', '127.0.0.1', $3, $4, 'local', 'active', clock_timestamp(), $5)`,
      [newId('end', Date.now()), clusterId, instance.port, PG_NAME, op],
    )

    // Enrollment (control-plane.md §4), the helper's trust, the helper and the agent.
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
    const revealed = await db.store('exdb_serve').transaction('test.reveal', (tx) =>
      revealEnrollmentToken(tx, keyring, clock, {
        tokenId,
        identityId,
        installationId: db.installationId,
      }),
    )
    const uid = Number((await run('id', ['-u', AGENT_USER ?? ''])).stdout.trim())
    const gid = Number((await run('id', ['-g', AGENT_USER ?? ''])).stdout.trim())
    const state = join(dir, 'state')
    await mkdir(state, { mode: 0o700 })
    await chown(state, uid, gid)
    await mkdir(join(dir, 'run'), { mode: 0o755 })
    const helperDir = join(dir, 'helper')
    await mkdir(helperDir, { mode: 0o700 })
    const configPath = join(dir, 'config.json')
    await writeFile(
      configPath,
      JSON.stringify({
        schema: 'exponetdb.node-config/v1',
        stateDirectory: state,
        helperSocket: join(dir, 'run', 'helper.sock'),
        agentUser: AGENT_USER,
        disabledCapabilities: [],
        instances: [instance],
      }),
      { mode: 0o644 },
    )
    const tokenPath = join(state, 'token')
    await writeFile(tokenPath, `${revealed.token}\n`, { mode: 0o600 })
    await chown(tokenPath, uid, gid)
    const env = { ...process.env, EXPONETDB_NODE_E2E_CLOCK: 'synchronized' }
    const asAgent = { uid, gid, env }
    const enrolled = await run(
      join(dir, 'exponetdb-node'),
      ['enroll', '--config', configPath, '--token-file', tokenPath],
      asAgent,
    )
    const nodeId = /enrolled as (nod_[0-9A-Z]{26})/.exec(enrolled.stdout)?.[1] ?? ''
    await rm(tokenPath)
    const trustPath = join(helperDir, 'trust.json')
    await run(
      join(dir, 'exponetdb-node-helper'),
      ['trust', '--agent-state', state, '--trust', trustPath],
      { env },
    )
    const logs: string[] = []
    const group = (await run('id', ['-gn', AGENT_USER ?? ''])).stdout.trim()
    if (SYSTEMD) {
      // The shipped units, with this test's paths: the hardening is the release's.
      await startUnits({ group, configPath, trustPath, helperDir, state })
    } else {
      const helper: ChildProcess = spawn(
        join(dir, 'exponetdb-node-helper'),
        [
          'serve',
          '--config',
          configPath,
          '--trust',
          trustPath,
          '--state-dir',
          join(helperDir, 'state'),
        ],
        { env },
      )
      helper.stderr?.on('data', (c: Buffer) => logs.push(`helper: ${c.toString('utf8')}`))
      stops.push(async () => helper.kill('SIGTERM'))
      await eventually(
        'the helper socket',
        async () => existsSync(join(dir, 'run', 'helper.sock')),
        (v) => v,
      )
      const agent: ChildProcess = spawn(
        join(dir, 'exponetdb-node'),
        ['run', '--config', configPath],
        asAgent,
      )
      agent.stderr?.on('data', (c: Buffer) => logs.push(`agent: ${c.toString('utf8')}`))
      stops.push(async () => agent.kill('SIGTERM'))
    }
    const allLogs = async () => (SYSTEMD ? await unitLogs() : logs.join(''))
    await eventually(
      'binding and the instance in hello',
      () => sql('SELECT state, clusters FROM nodes.nodes WHERE node_id = $1', [nodeId]),
      (rows) =>
        rows[0]?.state === 'active' &&
        Array.isArray(rows[0]?.clusters) &&
        rows[0].clusters.some(
          (c: { systemIdentifier: string }) => c.systemIdentifier === systemIdentifier,
        ),
    )

    const call = (method: string, path: string, body?: unknown) =>
      owner.browser.call(method, path, body)
    const inspect = async (
      capability: string,
      args: object = {},
      cluster: string | null = clusterId,
    ) => {
      const r = await call('POST', `/api/v1/nodes/${nodeId}/inspections`, {
        capability,
        clusterId: cluster,
        args,
      })
      expect([r.status, r.body?.code]).toEqual([202, undefined])
      const done = await finished(r.body.id)
      expect([done.state, done.verificationOutcome, done.errorCode], logs.join('')).toEqual([
        'succeeded',
        'passed',
        null,
      ])
      return done
    }
    const planAndApply = async (change: object) => {
      const planned = await call('POST', `/api/v1/nodes/${nodeId}/plans`, { clusterId, change })
      expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
        201,
        undefined,
      ])
      await reauth()
      const applied = await call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
      expect([applied.status, applied.body?.code], JSON.stringify(applied.body)).toEqual([
        202,
        undefined,
      ])
      return finished(applied.body.id)
    }

    // Observations: node-signed, kept with source and time; a host read too.
    await inspect('postgres.status@1')
    await inspect('memory.stats@1', {}, null)
    if (SYSTEMD) {
      // Failed units come from systemd through the helper.
      await inspect('system.health@1', {}, null)
    }
    const observed = await call(
      'GET',
      `/api/v1/nodes/${nodeId}/observations?clusterId=${clusterId}`,
    )
    expect(observed.status).toBe(200)
    const status = observed.body.items.find(
      (o: { capability: string }) => o.capability === 'postgres.status@1',
    )
    expect(status).toMatchObject({ source: 'agent_reported', clusterId, result: { running: true } })
    // A plan needs a recent basis observation of exactly its change.
    const noBasis = await call('POST', `/api/v1/nodes/${nodeId}/plans`, {
      clusterId,
      change: {
        kind: 'postgres.config.apply',
        changes: [{ name: 'work_mem', value: '7MB' }],
        reload: true,
      },
    })
    expect([noBasis.status, noBasis.body?.code]).toEqual([409, 'NODE_OBSERVATION_STALE'])

    // Configuration through the managed fragment (OD-20), verified by a fresh read.
    const workMem = { name: 'work_mem', value: '7MB' }
    await inspect('postgres.config.plan@1', { changes: [workMem] })
    const config = await planAndApply({
      kind: 'postgres.config.apply',
      changes: [workMem],
      reload: true,
    })
    expect([config.state, config.applyOutcome, config.verificationOutcome], logs.join('')).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    expect(await psql('SHOW work_mem')).toBe('7MB')
    // Planned, then the host changes: the worker's fresh read makes the plan stale; nothing is applied.
    const back = { name: 'work_mem', value: null }
    await inspect('postgres.config.plan@1', { changes: [back] })
    const planned = await call('POST', `/api/v1/nodes/${nodeId}/plans`, {
      clusterId,
      change: { kind: 'postgres.config.apply', changes: [back], reload: true },
    })
    expect(planned.status).toBe(201)
    await psql(`ALTER SYSTEM SET maintenance_work_mem = '70MB'`)
    await psql('SELECT pg_reload_conf()')
    await reauth()
    const staleOp = (await call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})).body
    const stale = await finished(staleOp.id)
    expect([stale.state, stale.applyOutcome, stale.errorCode]).toEqual([
      'failed',
      'not_applied',
      'PLAN_STALE',
    ])
    expect(await psql('SHOW work_mem')).toBe('7MB')
    await psql('ALTER SYSTEM RESET maintenance_work_mem')
    await psql('SELECT pg_reload_conf()')
    await inspect('postgres.config.plan@1', { changes: [back] })
    const removed = await planAndApply({
      kind: 'postgres.config.apply',
      changes: [back],
      reload: true,
    })
    expect([removed.state, removed.verificationOutcome]).toEqual(['succeeded', 'passed'])
    expect(await psql('SHOW work_mem')).toBe('4MB')

    // pg_hba: a managed block is written and verified; a block that would lock
    // the agent out is refused on the host and the file put back (G5 item 7).
    await inspect('postgres.hba.inspect@1')
    const rule = {
      type: 'hostssl',
      database: ['app'],
      user: ['app_user'],
      address: '10.1.0.0/16',
      method: 'scram-sha-256',
      map: null,
    }
    const hba = await planAndApply({
      kind: 'postgres.hba.apply',
      managedRules: [rule],
      protectedAccess: [],
    })
    expect([hba.state, hba.verificationOutcome], logs.join('')).toEqual(['succeeded', 'passed'])
    const before = readFileSync(instance.hbaFile)
    await inspect('postgres.hba.inspect@1')
    const lockout = await planAndApply({
      kind: 'postgres.hba.apply',
      managedRules: [
        {
          type: 'local',
          database: ['all'],
          user: ['all'],
          address: null,
          method: 'reject',
          map: null,
        },
      ],
      protectedAccess: [],
    })
    expect([lockout.state, lockout.applyOutcome]).toEqual(['failed', 'not_applied'])
    expect(Buffer.compare(readFileSync(instance.hbaFile), before)).toBe(0)
    expect(await psql('SELECT 1')).toBe('1')

    // Roles: typed steps against a fresh digest, verified by the inspection.
    const role = `e2e_${randomBytes(4).toString('hex')}`
    await inspect('postgres.roles.inspect@1')
    const roles = await planAndApply({
      kind: 'postgres.roles.apply',
      steps: [
        {
          op: 'create_role',
          role,
          attributes: {
            login: true,
            inherit: true,
            createdb: false,
            createrole: false,
            replication: false,
            bypassrls: false,
            connectionLimit: 3,
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
        {
          op: 'set_role_setting',
          role,
          attributes: null,
          verifier: null,
          member: null,
          admin: null,
          inherit: null,
          set: null,
          database: null,
          setting: 'work_mem',
          value: '16MB',
        },
      ],
    })
    expect([roles.state, roles.verificationOutcome], logs.join('')).toEqual(['succeeded', 'passed'])
    expect(await psql(`SELECT rolconnlimit FROM pg_roles WHERE rolname = '${role}'`)).toBe('3')
    // ExponetDB's own roles are never changed by a plan.
    await inspect('postgres.roles.inspect@1')
    const own = await call('POST', `/api/v1/nodes/${nodeId}/plans`, {
      clusterId,
      change: {
        kind: 'postgres.roles.apply',
        steps: [
          {
            op: 'clear_password',
            role: 'exponetdb_node',
            attributes: null,
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
    expect([own.status, own.body?.code]).toEqual([422, 'VALIDATION_FAILED'])

    // Extensions in a fresh database.
    const database = `e2e_${randomBytes(4).toString('hex')}`
    await psql(`CREATE DATABASE ${database}`)
    await inspect('postgres.extensions.inspect@1', { database })
    const versions = await psql(
      `SELECT default_version FROM pg_available_extensions WHERE name = 'pg_trgm'`,
      database,
    )
    const extensions = await planAndApply({
      kind: 'postgres.extensions.apply',
      database,
      steps: [{ op: 'create', name: 'pg_trgm', schema: 'public', version: versions }],
    })
    expect([extensions.state, extensions.verificationOutcome], logs.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(
      await psql(`SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'`, database),
    ).toBe(versions)

    // TLS: the key is made on the host, the worker issues the certificate from
    // the PostgreSQL CA, and a fresh connection presents it (OD-17).
    await inspect('postgres.tls.inspect@1')
    const tls = await planAndApply({
      kind: 'postgres.tls.rotate',
      dnsNames: [PG_NAME],
      ipAddresses: ['127.0.0.1'],
      validityDays: 30,
    })
    expect([tls.state, tls.verificationOutcome], logs.join('')).toEqual(['succeeded', 'passed'])
    const presented = await presentedCertificate(instance.port)
    const issued = await sql(
      `SELECT envelope -> 'args' -> 'certificateChain' ->> 0 AS leaf FROM nodes.jobs
        WHERE operation_id = $1 AND capability = 'postgres.tls.rotate@1'`,
      [tls.id],
    )
    expect(presented).toBe(
      createHash('sha256')
        .update(Buffer.from(issued[0]?.leaf ?? '', 'base64url'))
        .digest('hex'),
    )
    // A cluster whose CA bundle does not trust the PostgreSQL CA is refused at plan time.
    // (The bundle is immutable; this is checked against the registered one.)

    // Credential rotation: the worker generates the password, the node sets
    // its verifier, and a login over verify-full activates it (§9.7).
    await psql(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exponetdb_observer') THEN
           CREATE ROLE exponetdb_observer LOGIN;
         END IF;
       END $$`,
    )
    await psql('GRANT pg_monitor TO exponetdb_observer WITH INHERIT TRUE, SET FALSE')
    await inspect('postgres.roles.inspect@1')
    const rotation = await call(
      'POST',
      `/api/v1/clusters/${clusterId}/credentials/observer/rotate`,
      {},
    )
    expect([rotation.status, rotation.body?.code], JSON.stringify(rotation.body)).toEqual([
      201,
      undefined,
    ])
    await reauth()
    const rotated = await finished(
      (await call('POST', `/api/v1/plans/${rotation.body.id}/apply`, {})).body.id,
    )
    expect([rotated.state, rotated.verificationOutcome], logs.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    const credentials = await sql(
      `SELECT state FROM registry.credentials WHERE cluster_id = $1 AND access_role = 'observer'`,
      [clusterId],
    )
    expect(credentials.map((r) => r.state)).toEqual(['active'])
    expect(
      await psql(
        `SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname = 'exponetdb_observer'`,
      ),
    ).toBe('t')

    // Reload, and a restart where systemd runs the units.
    await inspect('postgres.status@1')
    const reload = await planAndApply({ kind: 'postgres.reload' })
    expect([reload.state, reload.verificationOutcome]).toEqual(['succeeded', 'passed'])
    if (SYSTEMD) {
      await inspect('postgres.restart.plan@1')
      const restart = await planAndApply({ kind: 'postgres.restart' })
      expect([restart.state, restart.verificationOutcome], logs.join('')).toEqual([
        'succeeded',
        'passed',
      ])
    }

    // Nothing the agent or the helper logged carries a secret.
    const text = await allLogs()
    expect(text).not.toContain('SCRAM-SHA-256$')
    expect(text).not.toContain(revealed.token.slice(7, 47))
    const audit = await sql(`SELECT event::text AS e FROM audit.audit_events`)
    expect(audit.some((r) => r.e.includes('SCRAM-SHA-256$'))).toBe(false)
  }, 900_000)
})

/** The sha256 of the certificate a TLS connection to the instance presents (PostgreSQL SSLRequest first). */
async function presentedCertificate(port: number): Promise<string> {
  const { Socket } = await import('node:net')
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    socket.connect(port, '127.0.0.1', () => {
      const request = Buffer.alloc(8)
      request.writeInt32BE(8, 0)
      request.writeInt32BE(80877103, 4)
      socket.write(request)
    })
    socket.once('data', (b: Buffer) => {
      if (b[0] !== 0x53) {
        reject(new Error('no TLS'))
        return
      }
      const tls = tlsConnect({ socket, rejectUnauthorized: false, servername: PG_NAME }, () => {
        const cert = tls.getPeerCertificate()
        tls.destroy()
        resolve(createHash('sha256').update(cert.raw).digest('hex'))
      })
      tls.once('error', reject)
    })
    socket.once('error', reject)
  })
}
