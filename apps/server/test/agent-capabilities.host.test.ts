import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootstrapOwner, totpCodeAt } from '@exponetdb/auth'
import { SoftAuthenticator } from '@exponetdb/auth/testing'
import type { ControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, parseId, systemClock } from '@exponetdb/kernel'
import { createEnrollmentToken, revealEnrollmentToken } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import { generateKeyringText, type Keyring, parseKeyring, readSecret } from '@exponetdb/secrets'
import { Secret } from 'otpauth'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { runCommand } from '../src/commands/index.ts'
import { composeAccess } from '../src/composition/access.ts'
import type { GatewayConfig, ServeConfig, WorkerConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import { runGateway, runWorker } from '../src/roles/roles.ts'
import { organization, placeTarget } from './support/node-world.ts'

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
): () => Promise<unknown> {
  let release: () => void = () => undefined
  const until = new Promise<void>((r) => {
    release = r
  })
  const exit = runner({ until, write: () => undefined })
  const stop = async () => {
    release()
    return exit
  }
  stops.push(stop)
  return stop
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
async function finished(operationId: string, ms = 180_000) {
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
    ms,
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
  const faults = `${clock}\nEnvironment=EXPONETDB_NODE_E2E_FAULTS=${p.state}/faults`
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
  agent = swap(agent, /^\[Service\]$/m, faults).replaceAll(
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
    let stopGateway = startRole((hooks) => runGateway(gatewayConfig, hooks))
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

    // A nonprod target on the cluster: the changes below run without an
    // approval; the production rule is shown at the end (Wave 5 correction F2).
    // Its databases exist on the instance: the worker logs in to the first one.
    const org = await organization(db)
    const runTag = randomBytes(3).toString('hex')
    await psql(`CREATE DATABASE exdbtest_staging_${runTag}`)
    await placeTarget(db, { ...org, clusterId }, 'nonprod', `exdbtest_staging_${runTag}`)

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
        // Two restarts minutes apart below; the spacing itself is
        // TestRestartsAreSpaced (the default is one per 10 minutes).
        restartIntervalSeconds: 0,
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
    // Without systemd the test restarts a crashed agent itself (Restart=on-failure).
    let agentProcess: ChildProcess | undefined
    let respawn = true
    const spawnAgent = () => {
      const p = spawn(join(dir, 'exponetdb-node'), ['run', '--config', configPath], {
        ...asAgent,
        env: { ...env, EXPONETDB_NODE_E2E_FAULTS: join(state, 'faults') },
      })
      p.stderr?.on('data', (c: Buffer) => logs.push(`agent: ${c.toString('utf8')}`))
      p.on('exit', () => {
        if (agentProcess === p && respawn) {
          setTimeout(() => respawn && spawnAgent(), 1000)
        }
      })
      agentProcess = p
    }
    const agentUnit = `${PREFIX}-node.service`
    const stopAgent = async () => {
      if (SYSTEMD) {
        await run('systemctl', ['stop', agentUnit])
        return
      }
      respawn = false
      const p = agentProcess
      if (p !== undefined && p.exitCode === null && p.signalCode === null) {
        const exited = new Promise((r) => p.once('exit', r))
        p.kill('SIGTERM')
        await exited
      }
    }
    const startAgent = async () => {
      if (SYSTEMD) {
        await run('systemctl', ['start', agentUnit])
        return
      }
      respawn = true
      spawnAgent()
    }
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
      spawnAgent()
      stops.push(async () => {
        respawn = false
        agentProcess?.kill('SIGTERM')
      })
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
    await inspect('postgres.config.plan@2', { changes: [workMem] })
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
    await inspect('postgres.config.plan@2', { changes: [back] })
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
    await inspect('postgres.config.plan@2', { changes: [back] })
    const removed = await planAndApply({
      kind: 'postgres.config.apply',
      changes: [back],
      reload: true,
    })
    expect([removed.state, removed.verificationOutcome]).toEqual(['succeeded', 'passed'])
    expect(await psql('SHOW work_mem')).toBe('4MB')

    // pg_hba: a managed block is written and verified; a block that would lock
    // the agent out is refused on the host and the file put back (G5 item 7).
    await inspect('postgres.hba.inspect@2')
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
    await inspect('postgres.hba.inspect@2')
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
    await inspect('postgres.roles.inspect@2', { expectSettings: [] })
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
    await inspect('postgres.roles.inspect@2', { expectSettings: [] })
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

    // ----- Confidentiality (Wave 5 correction F1) -----
    // Synthetic canaries where PostgreSQL keeps secrets of its own and of
    // extensions: a standard parameter (ALTER SYSTEM), a custom parameter in
    // a conf.d file and in the managed fragment (as an earlier change would
    // have written it), a role and a database setting, a foreign pg_hba rule
    // with LDAP and RADIUS secrets (parsed only; no server is contacted), and
    // a client's failed statement in the server log. Reads through REST and
    // an unrelated configuration change keep every one on the host and out
    // of the signed completions, jobs, observations, REST answers, audit and
    // operation events, the agent's and the helper's state and their logs.
    const canary = `EXDBHOSTCANARY${randomBytes(6).toString('hex')}`
    const canaryRole = `exdb_canary_${runTag}`
    const customFile = join(dirname(instance.configFile), 'conf.d', '50-exdb-host-canary.conf')
    const hbaBefore = readFileSync(instance.hbaFile)
    const fragmentBefore = readFileSync(instance.managedInclude)
    const header =
      '# ExponetDB managed configuration (OD-20), written by exponetdb-node-helper.\n' +
      '# Do not edit: the next postgres.config.apply replaces this file.\n'
    const fragmentText = fragmentBefore.length === 0 ? header : fragmentBefore.toString('utf8')
    expect(fragmentText.startsWith(header)).toBe(true)
    await psql(
      `ALTER SYSTEM SET primary_conninfo = 'host=192.0.2.1 user=replicator password=${canary}'`,
    )
    await psql(`CREATE ROLE ${canaryRole} NOLOGIN`)
    await psql(`ALTER ROLE ${canaryRole} SET exdbcanary.api_token = '${canary}'`)
    await psql(`ALTER DATABASE postgres SET exdbcanary.db_secret = '${canary}'`)
    writeFileSync(customFile, `exdbcanary.api_key = '${canary}'\n`, { mode: 0o644 })
    writeFileSync(
      instance.managedInclude,
      `${fragmentText}exdbcanary.fragment_token = '${canary}'\n`,
    )
    writeFileSync(
      instance.hbaFile,
      Buffer.concat([
        hbaBefore,
        Buffer.from(
          `\n# exdb host canary (test)\n` +
            `host all ${canaryRole} 192.0.2.0/24 ldap ldapserver=ldap.invalid ldapbasedn="dc=example" ldapbinddn="cn=reader" ldapbindpasswd=${canary} ldapsearchattribute=uid\n` +
            `host all ${canaryRole} 198.51.100.0/24 radius radiusservers=radius.invalid radiussecrets=${canary}\n`,
        ),
      ]),
    )
    await psql('SELECT pg_reload_conf()')
    // A client's statement that fails on its value: the server log quotes it.
    await psql(`SELECT '${canary}'::int`).then(
      () => {
        throw new Error('the canary statement ran')
      },
      () => undefined,
    )
    const logWindow = {
      since: new Date(Date.now() - 15 * 60_000).toISOString(),
      until: new Date(Date.now() + 60_000).toISOString(),
      minSeverity: 'info',
      maxLines: 500,
    }
    await inspect('postgres.config.inspect@2')
    await inspect('postgres.roles.inspect@2', { expectSettings: [] })
    await inspect('postgres.hba.inspect@2')
    await inspect('log.inspect@2', { source: 'postgresql', ...logWindow })
    await inspect('log.inspect@2', { source: 'agent', ...logWindow }, null)
    await inspect('log.inspect@2', { source: 'helper', ...logWindow }, null)
    await inspect('agent.diagnostics@2', {}, null)
    // The foreign rules served their purpose; the file goes back before the
    // configuration change reloads PostgreSQL.
    writeFileSync(instance.hbaFile, hbaBefore)
    await psql('SELECT pg_reload_conf()')
    // Another parameter changes: the withheld fragment value stays on the
    // host, and no job carries it there or back.
    await inspect('postgres.config.plan@2', { changes: [{ name: 'work_mem', value: '9MB' }] })
    const kept = await planAndApply({
      kind: 'postgres.config.apply',
      changes: [{ name: 'work_mem', value: '9MB' }],
      reload: true,
    })
    expect([kept.state, kept.applyOutcome, kept.verificationOutcome], logs.join('')).toEqual([
      'succeeded',
      'applied',
      'passed',
    ])
    expect(readFileSync(instance.managedInclude, 'utf8')).toBe(
      `${header}exdbcanary.fragment_token = '${canary}'\nwork_mem = '9MB'\n`,
    )
    expect(await psql('SHOW work_mem')).toBe('9MB')
    // A planned value the node withholds (a custom parameter) is never
    // compared on the host; the verification passes on the fragment digest
    // the signed apply statement reported (correction review, round 2).
    const custom = { name: 'exdbcanary.planned_setting', value: 'planned-value' }
    await inspect('postgres.config.plan@2', { changes: [custom] })
    const withheldChange = await planAndApply({
      kind: 'postgres.config.apply',
      changes: [custom],
      reload: true,
    })
    expect(
      [withheldChange.state, withheldChange.applyOutcome, withheldChange.verificationOutcome],
      logs.join(''),
    ).toEqual(['succeeded', 'applied', 'passed'])
    const verified = await sql(
      `SELECT j.completion -> 'result' -> 'parameters' -> 0 -> 'managed' ->> 'state' AS state FROM nodes.jobs j
        WHERE j.operation_id = $1 AND j.capability = 'postgres.config.plan@2' ORDER BY j.created_at DESC LIMIT 1`,
      [withheldChange.id],
    )
    expect(verified[0]?.state).toBe('held')
    // What a reader gets: values withheld as such, never the canary.
    const clusterReads = await call(
      'GET',
      `/api/v1/nodes/${nodeId}/observations?clusterId=${clusterId}`,
    )
    const nodeReads = await call('GET', `/api/v1/nodes/${nodeId}/observations`)
    expect([clusterReads.status, nodeReads.status]).toEqual([200, 200])
    expect(JSON.stringify(clusterReads.body)).not.toContain(canary)
    expect(JSON.stringify(nodeReads.body)).not.toContain(canary)
    const reads = [...clusterReads.body.items, ...nodeReads.body.items] as {
      capability: string
      clusterId: string | null
      result: Record<string, unknown>
    }[]
    const read = (capability: string) => reads.find((o) => o.capability === capability)?.result
    const settings = read('postgres.config.inspect@2')?.['settings'] as {
      name: string
      setting: unknown
    }[]
    expect(settings.find((s) => s.name === 'primary_conninfo')?.setting).toEqual({
      withheld: 'secret',
    })
    expect(typeof settings.find((s) => s.name === 'work_mem')?.setting).toBe('string')
    const roleSettings = JSON.stringify(read('postgres.roles.inspect@2'))
    expect(roleSettings).toContain('"exdbcanary.api_token"')
    expect(roleSettings).toContain('{"withheld":"unclassified"}')
    expect(JSON.stringify(read('postgres.hba.inspect@2'))).toContain(
      '{"name":"ldapbindpasswd","value":{"withheld":"secret"}}',
    )
    const serverLog = JSON.stringify(
      reads.find((o) => o.capability === 'log.inspect@2' && o.clusterId === clusterId)?.result,
    )
    expect(serverLog).toContain('invalid input syntax for type integer: [withheld]')
    // Every boundary: the signed completions and arguments the gateway
    // stored, the worker's judgments, observations, plans, operations,
    // events, audit and every other table of the Control Store.
    const holding = await db.asSuperuser(async (c) => {
      const { rows: tables } = await c.query(
        `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
      )
      const found: string[] = []
      for (const { t } of tables) {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE '%' || $1 || '%'`,
          [canary],
        )
        if (rows[0].n > 0) found.push(t)
      }
      return found
    })
    expect(holding).toEqual([])
    const statements = await sql(
      `SELECT count(*)::int AS n FROM nodes.jobs WHERE node_id = $1 AND completed_at > now() - interval '20 minutes'
          AND capability IN ('postgres.config.inspect@2', 'postgres.roles.inspect@2', 'postgres.hba.inspect@2',
                             'log.inspect@2', 'agent.diagnostics@2', 'postgres.config.apply@2')
          AND node_signature_valid`,
      [nodeId],
    )
    expect(statements[0]?.n).toBeGreaterThanOrEqual(8)
    // The agent's buffer and journal, the helper's state, and the logs.
    const filesHolding = (root: string): string[] =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
        .filter((f) => readFileSync(f).includes(canary))
    expect([...filesHolding(state), ...filesHolding(helperDir)]).toEqual([])
    expect(await allLogs()).not.toContain(canary)
    // The host values were never touched by ExponetDB; undo the test's own.
    writeFileSync(instance.managedInclude, fragmentBefore)
    rmSync(customFile)
    await psql('ALTER SYSTEM RESET primary_conninfo')
    await psql('ALTER DATABASE postgres RESET exdbcanary.db_secret')
    await psql(`DROP ROLE ${canaryRole}`)
    await psql('SELECT pg_reload_conf()')
    expect(await psql('SHOW work_mem')).toBe('4MB')

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
    await inspect('postgres.roles.inspect@2', { expectSettings: [] })
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
    // Canaries: a second rotation; the password it replaced no longer logs
    // in over verify-full, the new one does, and only the new one is active.
    await inspect('postgres.roles.inspect@2', { expectSettings: [] })
    const again = await call(
      'POST',
      `/api/v1/clusters/${clusterId}/credentials/observer/rotate`,
      {},
    )
    expect(again.status).toBe(201)
    await reauth()
    const rotatedAgain = await finished(
      (await call('POST', `/api/v1/plans/${again.body.id}/apply`, {})).body.id,
    )
    expect([rotatedAgain.state, rotatedAgain.verificationOutcome], logs.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    const observerCredentials = await sql(
      `SELECT secret_id, secret_version, state FROM registry.credentials
        WHERE cluster_id = $1 AND access_role = 'observer' ORDER BY submitted_at`,
      [clusterId],
    )
    expect(observerCredentials.map((v) => v.state)).toEqual(['retired', 'active'])
    const passwordOf = async (row: { secret_id: string; secret_version: number }) => {
      const secretId = parseId('sec', row.secret_id)
      if (!secretId.ok) throw new Error('secret id')
      return (
        await readSecret(db.store('exdb_serve'), keyring, {
          secretId: secretId.value,
          consumer: 'observer',
          version: row.secret_version,
        })
      ).toString('utf8')
    }
    const caFile = join(dir, 'postgres-ca.pem')
    await writeFile(caFile, caPem)
    const logsIn = (password: string) =>
      run(
        'psql',
        [
          `host=127.0.0.1 port=${instance.port} user=exponetdb_observer dbname=postgres sslmode=verify-full sslrootcert=${caFile}`,
          '-Atc',
          'SELECT 1',
        ],
        { env: { ...process.env, PGPASSWORD: password } },
      ).then(
        () => true,
        () => false,
      )
    expect(await logsIn(await passwordOf(observerCredentials[0] as never))).toBe(false)
    expect(await logsIn(await passwordOf(observerCredentials[1] as never))).toBe(true)

    // Reload, and a restart where systemd runs the units.
    await inspect('postgres.status@1')
    const reload = await planAndApply({ kind: 'postgres.reload' })
    expect([reload.state, reload.verificationOutcome]).toEqual(['succeeded', 'passed'])
    if (SYSTEMD) {
      await inspect('postgres.restart.plan@2')
      const restart = await planAndApply({ kind: 'postgres.restart' })
      expect([restart.state, restart.verificationOutcome], logs.join('')).toEqual([
        'succeeded',
        'passed',
      ])
    }

    // ----- Job-key rotation (control-plane.md §9.8) -----
    // Stage, add to the node, activate, remove the old key, retire it; the
    // agent and the root helper accept jobs the new key signs.
    const refusals: string[] = []
    const jobKey = async (...args: string[]) => {
      out.length = 0
      refusals.length = 0
      const code = await runCommand(['node-pki', 'job-key', ...args], {
        ...io,
        stderr: (t: string) => refusals.push(t),
      })
      return {
        code,
        body: code === 0 ? JSON.parse(out.join('')) : undefined,
        error: refusals.join(''),
      }
    }
    const configUpdate = async (body: object) => {
      const planned = await call('POST', `/api/v1/nodes/${nodeId}/config-updates`, body)
      expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
        201,
        undefined,
      ])
      await reauth()
      const applied = await call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
      expect(applied.status, JSON.stringify(applied.body)).toBe(202)
      return finished(applied.body.id)
    }
    const trustedKeys = async (): Promise<string[]> => {
      const rows = await sql('SELECT trusted_job_keys FROM nodes.nodes WHERE node_id = $1', [
        nodeId,
      ])
      return [...(rows[0]?.trusted_job_keys ?? [])].sort()
    }
    const signers = async (operationId: string) =>
      (
        await sql(
          `SELECT capability, envelope->'signature'->>'keyId' AS key FROM nodes.jobs
            WHERE operation_id = $1 ORDER BY created_at`,
          [operationId],
        )
      ).map((r) => `${r.capability} ${r.key}`)
    const firstKey: string = (await jobKey('list')).body.keys.find(
      (k: { state: string }) => k.state === 'active',
    ).keyId
    const staged = await jobKey('stage')
    expect(staged.code, staged.error).toBe(0)
    const newKey: string = staged.body.changed
    // Not activated while the node has not stated, node-signed, that its
    // agent and its root helper trust it (Wave 5 correction F8).
    expect(await jobKey('activate')).toMatchObject({ code: 2 })
    expect(refusals.join('')).toContain('job_key_trust_unproven')
    const added = await configUpdate({ addJobKeys: [newKey], retireJobKeys: [] })
    expect([added.state, added.verificationOutcome], logs.join('')).toEqual(['succeeded', 'passed'])
    expect(await trustedKeys()).toEqual([firstKey, newKey].sort())
    // The verification read is signed with the added key and accepted.
    expect(await signers(added.id)).toEqual([
      `agent.diagnostics@2 ${firstKey}`,
      `config.update@1 ${firstKey}`,
      `agent.diagnostics@2 ${newKey}`,
    ])
    const twice = await call('POST', `/api/v1/nodes/${nodeId}/config-updates`, {
      addJobKeys: [newKey],
      retireJobKeys: [],
    })
    expect([twice.status, twice.body?.details?.reason]).toEqual([409, 'job_key_not_addable'])
    // The verification read is the node's statement: both hold both keys.
    const statement = await sql(
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
    expect(await jobKey('activate')).toMatchObject({ code: 0 })
    // Signed with the new key from now on: the helper accepts it too.
    await inspect('postgres.status@1')
    const reloaded = await planAndApply({ kind: 'postgres.reload' })
    expect([reloaded.state, reloaded.verificationOutcome], logs.join('')).toEqual([
      'succeeded',
      'passed',
    ])
    expect(new Set((await signers(reloaded.id)).map((x) => x.split(' ')[1]))).toEqual(
      new Set([newKey]),
    )
    // The old key stays on the node for the 7-day overlap (ADR-0024 §1),
    // shortened here by moving its activation back; then it leaves the node
    // and is retired.
    const early = await call('POST', `/api/v1/nodes/${nodeId}/config-updates`, {
      addJobKeys: [],
      retireJobKeys: [firstKey],
    })
    expect([early.status, early.body?.details?.reason]).toEqual([409, 'job_key_overlap'])
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `UPDATE nodes.job_keys SET state_changed_at = state_changed_at - interval '8 days' WHERE key_id = $1`,
        [firstKey],
      )
      await c.query('COMMIT')
    })
    expect(await jobKey('retire', firstKey)).toMatchObject({ code: 2 })
    expect(refusals.join('')).toContain('job_key_still_trusted')
    const dropped = await configUpdate({ addJobKeys: [], retireJobKeys: [firstKey] })
    expect([dropped.state, dropped.verificationOutcome], logs.join('')).toEqual([
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

    // ----- Failure injection (G5 item 4; control-plane.md §9.4) -----
    // The e2e build's fault seam kills the agent (SIGKILL) once at a job
    // boundary, or holds it there; systemd (or this test without it)
    // restarts it. Each case ends in the outcome the host proves.
    const faults = join(state, 'faults')
    const inject = async (capability: string, point: string, action: 'crash' | 'hold') => {
      await writeFile(faults, `${capability} ${point} ${action}\n`, { mode: 0o600 })
      await chown(faults, uid, gid)
    }
    const configPlan = async (value: string | null) => {
      const changes = [{ name: 'work_mem', value }]
      await inspect('postgres.config.plan@2', { changes })
      const plan = await call('POST', `/api/v1/nodes/${nodeId}/plans`, {
        clusterId,
        change: { kind: 'postgres.config.apply', changes, reload: true },
      })
      expect([plan.status, plan.body?.code], JSON.stringify(plan.body)).toEqual([201, undefined])
      await reauth()
      const applied = await call('POST', `/api/v1/plans/${plan.body.id}/apply`, {})
      expect(applied.status).toBe(202)
      return applied.body.id as string
    }
    const applyJobs = async (operationId: string) =>
      sql(
        `SELECT job_id, state FROM nodes.jobs WHERE operation_id = $1 AND capability = 'postgres.config.apply@2'`,
        [operationId],
      )

    // Killed after accepting the job, before its start was acknowledged: it
    // never runs; its one statement says so.
    await inject('postgres.config.apply@2', 'accepted', 'crash')
    const unstarted = await finished(await configPlan('9MB'), 300_000)
    expect([unstarted.state, unstarted.applyOutcome, unstarted.errorCode], logs.join('')).toEqual([
      'failed',
      'not_applied',
      'JOB_EXPIRED',
    ])
    expect(existsSync(faults)).toBe(false)
    expect(await psql('SHOW work_mem')).toBe('4MB')

    // Killed at the effect point, before the host changed: the statement of
    // the interrupted job reports the effect step, so nothing is decided
    // before the settle time; then the host still shows the basis.
    await inject('postgres.config.apply@2', 'effect', 'crash')
    const beforeEffect = await finished(await configPlan('9MB'), 400_000)
    expect([beforeEffect.state, beforeEffect.applyOutcome], logs.join('')).toEqual([
      'failed',
      'not_applied',
    ])
    expect(await psql('SHOW work_mem')).toBe('4MB')
    expect((await applyJobs(beforeEffect.id)).length).toBe(1)

    // Killed after the effect, before the statement was stored: reconciled
    // from the host (applied), then verified by a fresh read; never run again.
    await inject('postgres.config.apply@2', 'executed', 'crash')
    const afterEffect = await finished(await configPlan('9MB'), 400_000)
    expect(
      [afterEffect.state, afterEffect.applyOutcome, afterEffect.verificationOutcome],
      logs.join(''),
    ).toEqual(['succeeded', 'applied', 'passed'])
    expect(await psql('SHOW work_mem')).toBe('9MB')
    expect((await applyJobs(afterEffect.id)).length).toBe(1)

    // The recovered statement proves the reload by its journaled steps
    // (ADR-0025): the effect step, then the reload step, both succeeded.
    const recovered = await sql(
      `SELECT completion->>'outcome' AS outcome, completion->'steps' AS steps FROM nodes.jobs
        WHERE operation_id = $1 AND capability = 'postgres.config.apply@2'`,
      [afterEffect.id],
    )
    expect(recovered[0]?.outcome).toBe('failed')
    expect(
      ((recovered[0]?.steps ?? []) as { name: string; state: string }[]).map(
        (x) => `${x.name}:${x.state}`,
      ),
    ).toEqual([
      'check:succeeded',
      'write_fragment:running',
      'write_fragment:succeeded',
      'reload:succeeded',
    ])

    // Killed after the statement was stored, after it was journaled and
    // closed, and after the gateway acknowledged it: each time the one
    // stored statement is the job's (succeeded, never signed again), and
    // the operation ends verified, with one apply job and one effect.
    let expectedValue = '9MB'
    for (const point of ['stored', 'closed', 'acknowledged'] as const) {
      expectedValue = expectedValue === '9MB' ? '10MB' : '9MB'
      await inject('postgres.config.apply@2', point, 'crash')
      const crashed = await finished(await configPlan(expectedValue), 400_000)
      expect(
        [point, crashed.state, crashed.applyOutcome, crashed.verificationOutcome],
        logs.join(''),
      ).toEqual([point, 'succeeded', 'applied', 'passed'])
      expect(await psql('SHOW work_mem')).toBe(expectedValue)
      const jobs = await applyJobs(crashed.id)
      expect(jobs.length, point).toBe(1)
      const stated = await sql(
        `SELECT completion->>'outcome' AS outcome FROM nodes.jobs WHERE job_id = $1`,
        [jobs[0]?.job_id],
      )
      expect([point, stated[0]?.outcome]).toEqual([point, 'succeeded'])
      expect(existsSync(faults), point).toBe(false)
    }

    // A partition and a lost lease: the agent is held after the effect, the
    // gateway goes away and another worker takes the operation over. The job
    // turns outcome_unknown, nothing is decided, and the statement the agent
    // delivers once the gateway is back decides.
    await inject('postgres.config.apply@2', 'executed', 'hold')
    const held = await configPlan(null)
    await eventually(
      'the held job to run',
      () => applyJobs(held),
      (rows) => rows[0]?.state === 'running',
    )
    await stopGateway()
    await sql(
      `UPDATE operations.operations SET lease_owner = $2, lease_expires_at = clock_timestamp() + interval '2 seconds'
        WHERE operation_id = $1`,
      [held, newId('prc', Date.now())],
    )
    await eventually(
      'the job lease to run out',
      () => applyJobs(held),
      (rows) => rows[0]?.state === 'outcome_unknown',
      150_000,
    )
    // Nothing is decided while the job's statement is missing.
    const open = await sql('SELECT state FROM operations.operations WHERE operation_id = $1', [
      held,
    ])
    expect(['running', 'needs_reconciliation']).toContain(open[0]?.state)
    await rm(faults)
    stopGateway = startRole((hooks) => runGateway(gatewayConfig, hooks))
    const partitioned = await finished(held, 400_000)
    expect(
      [partitioned.state, partitioned.applyOutcome, partitioned.verificationOutcome],
      logs.join(''),
    ).toEqual(['succeeded', 'applied', 'passed'])
    expect(await psql('SHOW work_mem')).toBe('4MB')
    const events = await sql(
      `SELECT kind FROM operations.operation_events WHERE operation_id = $1`,
      [held],
    )
    expect(events.map((e) => e.kind)).toContain('lease_taken_over')
    const late = await sql(
      `SELECT state, node_signature_valid FROM nodes.jobs
        WHERE operation_id = $1 AND capability = 'postgres.config.apply@2'`,
      [held],
    )
    expect(late).toEqual([{ state: 'completed', node_signature_valid: true }])

    if (SYSTEMD) {
      // Killed after the restart's statement was stored, before the journal
      // recorded it: the restarted agent completes the job from that
      // statement; PostgreSQL restarted exactly once.
      await inspect('postgres.restart.plan@2')
      const started = await psql('SELECT pg_postmaster_start_time()')
      await inject('postgres.restart@1', 'stored', 'crash')
      const restarted = await planAndApply({ kind: 'postgres.restart' })
      expect([restarted.state, restarted.verificationOutcome], logs.join('')).toEqual([
        'succeeded',
        'passed',
      ])
      const now = await psql('SELECT pg_postmaster_start_time()')
      expect(now).not.toBe(started)
      await new Promise((r) => setTimeout(r, 15_000))
      expect(await psql('SELECT pg_postmaster_start_time()')).toBe(now)
      const restartJobs = await sql(
        `SELECT count(*)::int AS n FROM nodes.jobs WHERE operation_id = $1 AND capability = 'postgres.restart@1'`,
        [restarted.id],
      )
      expect(restartJobs[0]?.n).toBe(1)
    }

    // A corrupted journal: the agent refuses every job (journal_corrupt)
    // and runs nothing; the operation proves nothing ran and fails.
    const journalFile = join(state, 'journal', 'journal.log')
    await stopAgent()
    const intact = readFileSync(journalFile)
    const broken = Buffer.from(intact)
    const middle = broken.indexOf('"hash":"sha256:', Math.floor(broken.length / 2)) + 20
    broken[middle] = broken[middle] === 0x30 ? 0x31 : 0x30
    await writeFile(journalFile, broken)
    await startAgent()
    const refusedRead = await call('POST', `/api/v1/nodes/${nodeId}/inspections`, {
      capability: 'postgres.status@1',
      clusterId,
      args: {},
    })
    const corrupt = await finished(refusedRead.body.id)
    expect([corrupt.state, corrupt.applyOutcome], logs.join('')).toEqual(['failed', 'not_applied'])
    await stopAgent()
    await writeFile(journalFile, intact)
    await startAgent()
    await inspect('postgres.status@1')

    // ----- Production (Wave 5 correction F2) -----
    // A production target makes the cluster production: a reload waits for a
    // human approval, the agent gets no job before it, and runs it after.
    await psql(`CREATE DATABASE exdbtest_production_${runTag}`)
    await placeTarget(db, { ...org, clusterId }, 'prod', `exdbtest_production_${runTag}`)
    await inspect('postgres.status@1')
    const prodPlan = await call('POST', `/api/v1/nodes/${nodeId}/plans`, {
      clusterId,
      change: { kind: 'postgres.reload' },
    })
    expect(prodPlan.body.requirements).toEqual([
      { kind: 'approval', count: 1, permission: 'plans.approve' },
    ])
    const awaiting = await call('POST', `/api/v1/plans/${prodPlan.body.id}/apply`, {})
    expect(awaiting.body).toMatchObject({ state: 'awaiting_approval' })
    // The worker never claims an operation awaiting approval (it polls every 2 s).
    await new Promise((r) => setTimeout(r, 5000))
    expect(
      await sql('SELECT count(*)::int AS n FROM nodes.jobs WHERE operation_id = $1', [
        awaiting.body.id,
      ]),
    ).toEqual([{ n: 0 }])
    await reauth()
    const approved = await call('POST', `/api/v1/approvals/${awaiting.body.id}/approve`, {
      planHash: prodPlan.body.planHash,
      acknowledgeSelfApproval: true,
    })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    const prodReload = await finished(awaiting.body.id)
    expect([prodReload.state, prodReload.verificationOutcome], logs.join('')).toEqual([
      'succeeded',
      'passed',
    ])

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
