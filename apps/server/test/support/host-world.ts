import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { chmod, chown, mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ControlStore } from '@exponetdb/control-store'
import {
  type MigratedTestDatabase,
  migratedTestDatabase,
  probeTestServer,
} from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { createEnrollmentToken, OFFLINE_AFTER_MS, revealEnrollmentToken } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import { generateKeyringText, type Keyring, parseKeyring } from '@exponetdb/secrets'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import { runCommand } from '../../src/commands/index.ts'
import { composeAccess } from '../../src/composition/access.ts'
import type { GatewayConfig, ServeConfig, WorkerConfig } from '../../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../../src/interfaces/http/app.ts'
import { runGateway, runWorker } from '../../src/roles/roles.ts'
import {
  type BrowserResponse,
  enrollOwner,
  ORIGIN,
  type Organization,
  organization,
  type Person,
  placeTarget,
} from './node-world.ts'

/**
 * The host world of the capability scenarios (G6 record, Part A §9): the real
 * serve (in process, REST), gateway and worker roles on a Control Store
 * database of its own, the Go agent (`exponetdb-node`, e2e build: a clock
 * assumed synchronized and a failure-injection seam) as an unprivileged OS
 * user, the root helper (`exponetdb-node-helper`, e2e build with the same
 * seams), and a disposable PostgreSQL cluster in the Debian layout
 * (tooling/dev/node-clusters.sh), recreated for each scenario so no scenario
 * inherits another's host state. Under systemd (PID 1) the shipped units run
 * the agent and the helper; without it the test runs and restarts them.
 *
 * Lab and product failures are told apart (Part A §8): before a scenario the
 * preflight checks root, the environment, the toolchain, disk space, the
 * Control Store and the cluster, and refuses with `LabUnavailable`; after a
 * failed test the same checks run again and the report says whether the lab
 * itself broke during the run (a Control Store shutting down, a stopped
 * cluster) before anyone reads the assertion as a product defect. With
 * EXDB_LAB_RUN_DIR set, each scenario writes its run record there
 * (`<scenario>.json`: running, then its outcome), never a stale "passed".
 *
 * Host scenarios need root and a disposable machine: the preflight refuses a
 * cluster that is not the test cluster `exdbnode`.
 */

export const SYSTEMD = existsSync('/run/systemd/system')
export const SERVER_NAME = 'gateway.exdb.test'
export const PG_NAME = 'pg17.exdb.test'
export const AGENT_DIR = fileURLToPath(new URL('../../../../agent/node/', import.meta.url))
const UNITS = fileURLToPath(new URL('../../../../agent/node/packaging/systemd/', import.meta.url))
const CLUSTER_SCRIPT = fileURLToPath(
  new URL('../../../../tooling/dev/node-clusters.sh', import.meta.url),
)

export const run = promisify(execFile)

export interface Instance {
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

// ----- lab preflight and diagnosis -----

export type LabCategory =
  | 'not_root'
  | 'environment'
  | 'platform'
  | 'toolchain'
  | 'disk'
  | 'control_store_unreachable'
  | 'control_store_shutting_down'
  | 'cluster_offline'
  | 'cluster_not_disposable'
  | 'fixture_stale'

/** The lab cannot run the scenario: never a product failure. */
export class LabUnavailable extends Error {
  readonly category: LabCategory
  constructor(category: LabCategory, detail: string) {
    super(`LAB (not a product failure): ${category}: ${detail}`)
    this.name = 'LabUnavailable'
    this.category = category
  }
}

export interface LabProblem {
  readonly category: LabCategory
  readonly detail: string
}

const CLUSTER_NAME = 'exdbnode'

/** The Control Store server answers a query now (5 s), or why not. */
async function controlStoreProblem(): Promise<LabProblem | undefined> {
  if (process.env['EXDB_TEST_PG_URL'] === undefined) {
    return { category: 'environment', detail: 'EXDB_TEST_PG_URL is not set' }
  }
  const failure = await probeTestServer(5000)
  if (failure === undefined) {
    return undefined
  }
  const { code, message } = failure
  if (code === '57P03' || code === '57P01' || /shutting down|starting up/.test(message)) {
    return { category: 'control_store_shutting_down', detail: message }
  }
  return {
    category: 'control_store_unreachable',
    detail: `${code === undefined ? '' : `${code}: `}${message}`,
  }
}

/** The disposable cluster of `major` is online, or why not. */
async function clusterProblem(major: number): Promise<LabProblem | undefined> {
  const listed = await run('pg_lsclusters', ['-h']).then(
    (r) => r.stdout,
    (e: unknown) => {
      throw new LabUnavailable('toolchain', `pg_lsclusters: ${String(e)}`)
    },
  )
  const row = listed
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find((f) => f[0] === String(major) && f[1] === CLUSTER_NAME)
  if (row === undefined) {
    return { category: 'cluster_offline', detail: `no cluster ${major}/${CLUSTER_NAME}` }
  }
  if (row[3] !== 'online') {
    return { category: 'cluster_offline', detail: `cluster ${major}/${CLUSTER_NAME} is ${row[3]}` }
  }
  return undefined
}

/** What is wrong with the lab right now (empty: nothing found). */
export async function labDiagnosis(major = 17): Promise<LabProblem[]> {
  const problems: LabProblem[] = []
  const store = await controlStoreProblem()
  if (store !== undefined) problems.push(store)
  try {
    const cluster = await clusterProblem(major)
    if (cluster !== undefined) problems.push(cluster)
  } catch (error) {
    if (error instanceof LabUnavailable) {
      problems.push({ category: error.category, detail: error.message })
    } else {
      throw error
    }
  }
  try {
    const fs = await statfs('/var/lib')
    const free = fs.bavail * fs.bsize
    if (free < 512 * 1024 * 1024) {
      problems.push({
        category: 'disk',
        detail: `${Math.floor(free / 1024 / 1024)} MiB free in /var/lib`,
      })
    }
  } catch (error) {
    problems.push({ category: 'disk', detail: String(error) })
  }
  return problems
}

/** Refuses with `LabUnavailable` when the lab cannot run a host scenario. */
export async function labPreflight(major = 17): Promise<{ agentUser: string; clusters: string }> {
  if (process.platform !== 'linux') {
    throw new LabUnavailable('platform', `${process.platform} is not supported (Linux only)`)
  }
  if (process.getuid?.() !== 0) {
    throw new LabUnavailable('not_root', 'host scenarios run as root (the helper is root)')
  }
  const clusters = process.env['EXDB_NODE_CLUSTERS']
  const agentUser = process.env['EXDB_NODE_E2E_AGENT_USER']
  if (clusters === undefined || agentUser === undefined) {
    throw new LabUnavailable(
      'environment',
      'set EXDB_NODE_CLUSTERS (tooling/dev/node-clusters.sh) and EXDB_NODE_E2E_AGENT_USER (an unprivileged OS user the clusters map to exponetdb_node)',
    )
  }
  if (!existsSync(CLUSTER_SCRIPT)) {
    throw new LabUnavailable('environment', `${CLUSTER_SCRIPT} is missing`)
  }
  for (const tool of ['go', 'pg_createcluster', 'pg_ctlcluster', 'pg_lsclusters', 'runuser']) {
    await run('bash', ['-c', `command -v ${tool}`]).catch(() => {
      throw new LabUnavailable('toolchain', `${tool} is not installed`)
    })
  }
  await run('id', ['-u', agentUser]).catch(() => {
    throw new LabUnavailable('environment', `no OS user ${agentUser}`)
  })
  const problems = (await labDiagnosis(major)).filter((p) => p.category !== 'cluster_offline')
  const first = problems[0]
  if (first !== undefined) {
    throw new LabUnavailable(first.category, first.detail)
  }
  return { agentUser, clusters }
}

// ----- run records -----

interface RunRecord {
  readonly schema: 'exponetdb.lab-scenario/v1'
  readonly scenario: string
  readonly state: 'running' | 'passed' | 'failed' | 'lab_unavailable'
  readonly pid: number
  readonly startedAt: string
  readonly endedAt: string | null
  readonly failedTests: readonly string[]
  readonly labProblems: readonly LabProblem[]
}

async function writeRecord(record: RunRecord): Promise<void> {
  const dir = process.env['EXDB_LAB_RUN_DIR']
  if (dir === undefined || dir === '') return
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, `${record.scenario}.json`), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  })
}

// ----- small helpers -----

export async function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const address = s.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      s.close(() => done(port))
    })
  })
}

export async function eventually<T>(
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

/** Replaces exactly one match, so a test fails when the shipped unit changes shape. */
function swap(text: string, pattern: RegExp, replacement: string): string {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))
  if (matches?.length !== 1) {
    throw new Error(`unit: expected one ${pattern} in the shipped unit`)
  }
  return text.replace(pattern, replacement)
}

export interface Finished {
  readonly id: string
  readonly state: string
  readonly applyOutcome: string
  readonly verificationOutcome: string
  readonly errorCode: string | null
}

const ENDED = ['succeeded', 'failed', 'verification_failed', 'needs_attention', 'canceled']

// ----- the world -----

export interface HostWorldOptions {
  /** Short name: the database, the directory and the run record carry it. */
  readonly scenario: string
  /** Recreate the disposable cluster first (default true). */
  readonly freshCluster?: boolean
}

export interface Node {
  readonly nodeId: string
  /** The revealed enrollment token (the scenario's canary for logs). */
  readonly token: string
  readonly uid: number
  readonly gid: number
  readonly state: string
  readonly helperDir: string
  readonly configPath: string
  readonly trustPath: string
  /** The agent's failure-injection file (`<capability> <point> crash|hold`). */
  readonly faults: string
  /** The helper's failure-injection file (`<op> <point> crash|hold`). */
  readonly helperFaults: string
}

export class HostWorld {
  readonly scenario: string
  readonly keyringText = generateKeyringText('k2026c')
  readonly runTag = randomBytes(3).toString('hex')
  db!: MigratedTestDatabase
  dir = ''
  keyring!: Keyring
  worker!: ControlStore
  app!: ReturnType<typeof createPublicApp>
  owner!: Person
  instance!: Instance
  agentUser = ''
  caPem = ''
  port = 0
  serverId = ''
  clusterId = ''
  systemIdentifier = ''
  org!: Organization
  node: Node | undefined
  /** Lines the agent and the helper wrote (without systemd; with it, see `logs()`). */
  readonly lines: string[] = []
  readonly #stops: (() => Promise<unknown>)[] = []
  #gatewayConfig!: GatewayConfig
  #workerConfig!: WorkerConfig
  #stopGateway: (() => Promise<unknown>) | undefined
  #stopWorker: (() => Promise<unknown>) | undefined
  #agent: ChildProcess | undefined
  #helper: ChildProcess | undefined
  #respawnAgent = true
  #respawnHelper = true
  readonly #prefix: string

  constructor(scenario: string) {
    this.scenario = scenario
    this.#prefix = `exdb-host-${scenario}`.slice(0, 40)
  }

  get prefix(): string {
    return this.#prefix
  }

  get commandEnv() {
    return {
      EXPONETDB_CONTROL_STORE_URL: this.db.url('exdb_worker'),
      EXPONETDB_KEYRING: this.keyringText,
    }
  }

  /** Runs a server command (`node-pki …`) and returns its exit code and output. */
  async command(args: readonly string[]) {
    const out: string[] = []
    const err: string[] = []
    const code = await runCommand([...args], {
      env: this.commandEnv,
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => err.push(t),
    })
    return { code, stdout: out.join(''), stderr: err.join('') }
  }

  sql = async (text: string, params: unknown[] = []) =>
    (await this.db.asSuperuser((c) => c.query(text, params))).rows

  async psql(query: string, database = 'postgres'): Promise<string> {
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
      String(this.instance.port),
      '-d',
      database,
      '-c',
      query,
    ])
    return stdout.trim()
  }

  call = (method: string, path: string, body?: unknown): Promise<BrowserResponse> =>
    this.owner.browser.call(method, path, body)

  async reauth(): Promise<void> {
    await this.owner.reauth()
  }

  /** Waits for an operation to end; its outcome as `GET /operations/{id}` shows it. */
  async finished(operationId: string, ms = 180_000): Promise<Finished> {
    const read = async () => {
      const r = await this.call('GET', `/api/v1/operations/${operationId}`)
      if (r.status !== 200) {
        throw new Error(`GET /operations/${operationId}: ${r.status} ${JSON.stringify(r.body)}`)
      }
      return {
        id: String(r.body.id),
        state: String(r.body.state),
        applyOutcome: String(r.body.applyOutcome),
        verificationOutcome: String(r.body.verificationOutcome),
        errorCode: (r.body.errorCode ?? null) as string | null,
      }
    }
    return eventually(`operation ${operationId}`, read, (op) => ENDED.includes(op.state), ms)
  }

  /** An inspection through REST that must succeed. */
  async inspect(capability: string, args: object = {}, cluster: string | null = this.clusterId) {
    const node = this.requireNode()
    const r = await this.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
      capability,
      clusterId: cluster,
      args,
    })
    expect([r.status, r.body?.code]).toEqual([202, undefined])
    const done = await this.finished(r.body.id)
    expect([done.state, done.verificationOutcome, done.errorCode], this.lines.join('')).toEqual([
      'succeeded',
      'passed',
      null,
    ])
    return done
  }

  /** Plans a node change through REST, re-authenticates, applies it and waits. */
  async planAndApply(change: object): Promise<Finished> {
    return this.finished(await this.apply(change))
  }

  /** Plans a node change through REST; the raw response. */
  async plan(change: object): Promise<BrowserResponse> {
    const node = this.requireNode()
    return this.call('POST', `/api/v1/nodes/${node.nodeId}/plans`, {
      clusterId: this.clusterId,
      change,
    })
  }

  /** Plans and applies; returns the operation id without waiting. */
  async apply(change: object): Promise<string> {
    const planned = await this.plan(change)
    expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
      201,
      undefined,
    ])
    await this.reauth()
    const applied = await this.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect([applied.status, applied.body?.code], JSON.stringify(applied.body)).toEqual([
      202,
      undefined,
    ])
    return applied.body.id as string
  }

  /**
   * Waits until the node takes jobs again (bound, with a heartbeat within the offline
   * threshold): after a gateway outage the agent reconnects with a back-off.
   */
  async nodeOnline(ms = 120_000): Promise<void> {
    const node = this.requireNode()
    await eventually(
      'the node to be online',
      () =>
        this.sql(
          `SELECT (state IN ('active', 'degraded')
                   AND last_heartbeat_at > clock_timestamp() - make_interval(secs => $2::double precision / 1000))
                  AS online
             FROM nodes.nodes WHERE node_id = $1`,
          [node.nodeId, OFFLINE_AFTER_MS],
        ),
      (rows) => rows[0]?.online === true,
      ms,
    )
  }

  /** A configuration change planned against a fresh basis read; returns the operation id. */
  async configChange(value: string | null, name = 'work_mem'): Promise<string> {
    const changes = [{ name, value }]
    await this.inspect('postgres.config.plan@2', { changes })
    return this.apply({ kind: 'postgres.config.apply', changes, reload: true })
  }

  async applyJobs(operationId: string, capability = 'postgres.config.apply@2') {
    return this.sql(
      `SELECT job_id, state, completion->>'outcome' AS outcome FROM nodes.jobs
        WHERE operation_id = $1 AND capability = $2 ORDER BY created_at`,
      [operationId, capability],
    )
  }

  /** A REST call with a bearer credential (an API key or an access token). */
  async bearer(token: string, path: string, method = 'GET', body?: unknown) {
    const response = await this.app.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
  }

  /** A service account bound to a role through the access change the owner applies. */
  async serviceAccount(name: string, roleId: string): Promise<string> {
    await this.reauth()
    const created = await this.call('POST', '/api/v1/service-accounts', { displayName: name })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const planned = await this.call('POST', '/api/v1/role-bindings', {
      identityId: created.body.id,
      roleId,
      scope: { kind: 'global' },
    })
    expect(planned.status, JSON.stringify(planned.body)).toBe(201)
    await this.reauth()
    const applied = await this.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status).toBe(202)
    const done = await this.finished(applied.body.id)
    expect(done.state).toBe('succeeded')
    return String(created.body.id)
  }

  /** An API key of a service account, shown once. */
  async apiKey(
    account: string,
    scopes: string[],
    tiers: ('prod' | 'nonprod')[] = ['prod', 'nonprod'],
  ): Promise<string> {
    await this.reauth()
    const key = await this.call('POST', `/api/v1/service-accounts/${account}/api-keys`, {
      scopes,
      restrictions: { tiers, targets: { kind: 'all' } },
      lifetimeDays: 30,
      ...(tiers.includes('prod') ? { acknowledgeProductionWrite: true } : {}),
    })
    expect(key.status, JSON.stringify(key.body)).toBe(201)
    return String(key.body.secret)
  }

  requireNode(): Node {
    if (this.node === undefined) throw new Error('no node enrolled in this world')
    return this.node
  }

  /** Arms the agent's failure seam once (`crash` kills it with SIGKILL; `hold` waits). */
  async inject(capability: string, point: string, action: 'crash' | 'hold') {
    const node = this.requireNode()
    await writeFile(node.faults, `${capability} ${point} ${action}\n`, { mode: 0o600 })
    await chown(node.faults, node.uid, node.gid)
  }

  /** Arms the helper's failure seam once (root-owned). */
  async injectHelper(op: string, point: string, action: 'crash' | 'hold') {
    const node = this.requireNode()
    await writeFile(node.helperFaults, `${op} ${point} ${action}\n`, { mode: 0o600 })
  }

  /** A point in the logs: `logs(mark)` returns only what was written after it. */
  logMark(): { readonly lines: number; readonly since: string } {
    // journalctl --since takes local "YYYY-MM-DD HH:MM:SS"; one second earlier is harmless.
    const at = new Date(Date.now() - 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const since = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    return { lines: this.lines.length, since }
  }

  async logs(mark?: { readonly lines: number; readonly since: string }): Promise<string> {
    if (!SYSTEMD) return this.lines.slice(mark?.lines ?? 0).join('')
    const { stdout } = await run('journalctl', [
      '--no-pager',
      '-o',
      'cat',
      '-u',
      `${this.#prefix}-node.service`,
      '-u',
      `${this.#prefix}-helper.service`,
      ...(mark === undefined ? [] : ['--since', mark.since]),
    ])
    return stdout
  }

  /** Runs a server role until the returned stop is called (stopped at dispose at the latest). */
  startRole(
    runner: (hooks: { until: Promise<unknown>; write: () => void }) => Promise<number>,
  ): () => Promise<unknown> {
    let release: () => void = () => undefined
    const until = new Promise<void>((r) => {
      release = r
    })
    const exit = runner({ until, write: () => undefined })
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      release()
      return exit
    }
    this.#stops.push(stop)
    return stop
  }

  async stopGateway(): Promise<void> {
    await this.#stopGateway?.()
    this.#stopGateway = undefined
  }

  startGateway(): void {
    this.#stopGateway = this.startRole((hooks) => runGateway(this.#gatewayConfig, hooks))
  }

  get gatewayConfig(): GatewayConfig {
    return this.#gatewayConfig
  }

  async stopWorker(): Promise<void> {
    await this.#stopWorker?.()
    this.#stopWorker = undefined
  }

  startWorker(): void {
    this.#stopWorker = this.startRole((hooks) => runWorker(this.#workerConfig, hooks))
  }

  /** Builds the binaries, the Control Store, the roles, the owner and the registry. */
  async start(options: HostWorldOptions): Promise<void> {
    const { agentUser, clusters } = await labPreflight(17)
    this.agentUser = agentUser
    this.instance = await this.#cluster(clusters, options.freshCluster ?? true)
    this.db = await migratedTestDatabase(`exdb_host_${this.scenario.replaceAll('-', '_')}`)
    // Outside /tmp: under systemd the units have a private /tmp.
    this.dir = await mkdtemp(`/var/lib/exdb-host-${this.scenario}-`)
    await chmod(this.dir, 0o755)
    await Promise.all(
      (['exponetdb-node', 'exponetdb-node-helper'] as const).map((binary) =>
        run('go', ['build', '-tags', 'e2e', '-o', join(this.dir, binary), `./cmd/${binary}`], {
          cwd: AGENT_DIR,
        }),
      ),
    )
    const parsed = parseKeyring(this.keyringText)
    if (!parsed.ok) throw new Error('keyring')
    this.keyring = parsed.value
    this.worker = this.db.store('exdb_worker')
    this.port = await freePort()
    const init = await this.command([
      'node-pki',
      'init',
      '--gateway-url',
      `https://127.0.0.1:${this.port}`,
      '--server-name',
      SERVER_NAME,
      '--root-key-out',
      join(this.dir, 'root-key.pem'),
    ])
    expect(init.code, init.stderr).toBe(0)
    const ca = await this.command(['node-pki', 'postgres-ca'])
    expect(ca.code, ca.stderr).toBe(0)
    const created = JSON.parse(ca.stdout)
    expect(created.created).toBe(true)
    this.caPem = created.certificatePem
    const again = await this.command(['node-pki', 'postgres-ca'])
    expect(JSON.parse(again.stdout)).toMatchObject({
      created: false,
      fingerprint: created.fingerprint,
    })

    const serveConfig: ServeConfig = {
      role: 'serve',
      logLevel: 'warn',
      otlpEndpoint: undefined,
      controlStoreUrl: this.db.url('exdb_serve'),
      installationId: this.db.installationId,
      keyringEnv: {},
      internalListen: { host: '127.0.0.1', port: 0 },
      shutdownTimeoutMs: 10_000,
      listen: { host: '127.0.0.1', port: 0 },
      publicUrl: ORIGIN,
      webauthnRpId: undefined,
      trustedProxies: [],
      egressAddresses: [],
      mcpAllowedOrigins: [],
      clientRegistration: 'review',
    }
    const logger = createLogger({ role: 'serve', level: 'warn', write: () => undefined })
    const access = composeAccess(
      serveConfig,
      { store: this.db.store('exdb_serve'), keyring: this.keyring },
      { clock: systemClock },
    )
    expect((await access.roleCatalogCheck.run()).status).toBe('pass')
    expect((await access.scopeCatalogCheck.run()).status).toBe('pass')
    this.app = createPublicApp(
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
      keyringEnv: { EXPONETDB_KEYRING: this.keyringText },
      installationId: this.db.installationId,
    }
    this.#gatewayConfig = {
      ...common,
      role: 'gateway',
      controlStoreUrl: this.db.url('exdb_gateway'),
      agentListen: { host: '127.0.0.1', port: this.port },
    }
    this.#workerConfig = {
      ...common,
      role: 'worker',
      controlStoreUrl: this.db.url('exdb_worker'),
      auditExport: { kind: 'none' },
    }
    this.startGateway()
    this.startWorker()
    await eventually(
      'the agent listener',
      () =>
        new Promise<boolean>((done) => {
          const socket = connect(this.port, '127.0.0.1')
          socket.once('connect', () => {
            socket.destroy()
            done(true)
          })
          socket.once('error', () => done(false))
        }),
      (open) => open,
    )
    this.owner = await enrollOwner(this.db, (input, init) => this.app.request(input, init))
    await this.#registry()
  }

  /** The disposable cluster: recreated for this scenario, or the one already there. */
  async #cluster(clusters: string, fresh: boolean): Promise<Instance> {
    const pick = (file: string): Instance => {
      const instances = JSON.parse(readFileSync(file, 'utf8')) as Instance[]
      const found = instances.find((i) => i.localName === `17/${CLUSTER_NAME}`)
      if (found === undefined) {
        throw new LabUnavailable(
          'cluster_not_disposable',
          `${file} has no PostgreSQL 17 instance named ${CLUSTER_NAME}`,
        )
      }
      return found
    }
    const listed = pick(clusters)
    if (fresh) {
      // The script drops and recreates the cluster named exdbnode only.
      const out = await mkdtemp('/var/lib/exdb-host-clusters-')
      await run('bash', [CLUSTER_SCRIPT, out], {
        env: {
          ...process.env,
          EXDB_NODE_PG_VERSIONS: '17',
          EXDB_NODE_AGENT_USER: process.env['EXDB_NODE_AGENT_USERS'] ?? `root ${this.agentUser}`,
        },
      })
      const recreated = pick(join(out, 'clusters.json'))
      await rm(out, { recursive: true, force: true })
      if (JSON.stringify(recreated) !== JSON.stringify(listed)) {
        throw new LabUnavailable(
          'cluster_not_disposable',
          'the recreated cluster differs from EXDB_NODE_CLUSTERS',
        )
      }
      // A recreated cluster carries nothing of an earlier run: no managed
      // fragment, no helper copies (*.exponetdb-previous).
      const etc = dirname(recreated.configFile)
      const leftovers = [
        ...readdirSync(join(etc, 'conf.d')).map((f) => `conf.d/${f}`),
        ...readdirSync(etc).filter((f) => f.endsWith('.exponetdb-previous')),
      ]
      if (leftovers.length > 0) {
        throw new LabUnavailable(
          'fixture_stale',
          `the recreated cluster holds files of an earlier run: ${leftovers.join(', ')}`,
        )
      }
    }
    const problem = await clusterProblem(17)
    if (problem !== undefined) {
      throw new LabUnavailable(problem.category, problem.detail)
    }
    return listed
  }

  /**
   * The registry: a server and its agent-managed cluster pinned to the
   * instance's system identifier, whose CA bundle trusts the PostgreSQL CA,
   * and a nonprod target placed on it.
   */
  async #registry(): Promise<void> {
    const op = newId('op', Date.now())
    await this.sql(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'registry.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [op],
    )
    this.serverId = newId('srv', Date.now())
    this.clusterId = newId('cls', Date.now())
    this.systemIdentifier = await this.psql('SELECT system_identifier FROM pg_control_system()')
    await this.worker.query(
      'test.server',
      `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
       VALUES ($1, 'db host', 'other', '{}', $2)`,
      [this.serverId, op],
    )
    await this.sql(
      `INSERT INTO registry.clusters (cluster_id, server_id, management_mode, display_name, state, ca_bundle, created_by_operation_id)
       VALUES ($1, $2, 'agent', 'main', 'pending', $3, $4)`,
      [this.clusterId, this.serverId, this.caPem, op],
    )
    await this.sql(
      `UPDATE registry.clusters SET state = 'active', system_identifier = $2, server_version_num = 170000,
              confirmed_by_operation_id = $3 WHERE cluster_id = $1`,
      [this.clusterId, this.systemIdentifier, op],
    )
    await this.sql(
      `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, host, port, tls_server_name, label, state, created_at,
                                       created_by_operation_id)
       VALUES ($1, $2, 'private', '127.0.0.1', $3, $4, 'local', 'active', clock_timestamp(), $5)`,
      [newId('end', Date.now()), this.clusterId, this.instance.port, PG_NAME, op],
    )
    this.org = await organization(this.db)
    await this.psql(`CREATE DATABASE exdbtest_staging_${this.runTag}`)
    await placeTarget(
      this.db,
      { ...this.org, clusterId: this.clusterId },
      'nonprod',
      `exdbtest_staging_${this.runTag}`,
    )
  }

  /** Places a production target on the cluster (it becomes production). */
  async placeProduction(): Promise<void> {
    await this.psql(`CREATE DATABASE exdbtest_production_${this.runTag}`)
    await placeTarget(
      this.db,
      { ...this.org, clusterId: this.clusterId },
      'prod',
      `exdbtest_production_${this.runTag}`,
    )
  }

  /** A revealed enrollment token for the server (as the Web App reveals it). */
  async enrollmentToken(): Promise<string> {
    const op = newId('op', Date.now())
    await this.sql(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'registry.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [op],
    )
    const tokenId = newId('ent', Date.now())
    const identityId = newId('idn', Date.now())
    const clock = { nowMs: () => Date.now() }
    await this.worker.transaction('test.token', (tx) =>
      createEnrollmentToken(tx, clock, {
        tokenId,
        serverId: this.serverId,
        revealBy: identityId,
        operationId: op,
      }),
    )
    const revealed = await this.db.store('exdb_serve').transaction('test.reveal', (tx) =>
      revealEnrollmentToken(tx, this.keyring, clock, {
        tokenId,
        identityId,
        installationId: this.db.installationId,
      }),
    )
    return revealed.token
  }

  /** The agent's state, configuration and token file; the agent user owns them. */
  async prepareNode(suffix = ''): Promise<Omit<Node, 'nodeId' | 'token'>> {
    const uid = Number((await run('id', ['-u', this.agentUser])).stdout.trim())
    const gid = Number((await run('id', ['-g', this.agentUser])).stdout.trim())
    const state = join(this.dir, `state${suffix}`)
    await mkdir(state, { mode: 0o700 })
    await chown(state, uid, gid)
    await mkdir(join(this.dir, 'run'), { recursive: true, mode: 0o755 })
    const helperDir = join(this.dir, `helper${suffix}`)
    await mkdir(helperDir, { mode: 0o700 })
    const configPath = join(this.dir, `config${suffix}.json`)
    await writeFile(
      configPath,
      JSON.stringify({
        schema: 'exponetdb.node-config/v1',
        stateDirectory: state,
        helperSocket: join(this.dir, 'run', 'helper.sock'),
        agentUser: this.agentUser,
        disabledCapabilities: [],
        // Restarts minutes apart; the spacing itself is TestRestartsAreSpaced.
        restartIntervalSeconds: 0,
        instances: [this.instance],
      }),
      { mode: 0o644 },
    )
    return {
      uid,
      gid,
      state,
      helperDir,
      configPath,
      trustPath: join(helperDir, 'trust.json'),
      faults: join(state, 'faults'),
      helperFaults: join(helperDir, 'faults'),
    }
  }

  get agentEnv() {
    return { ...process.env, EXPONETDB_NODE_E2E_CLOCK: 'synchronized' }
  }

  /** `exponetdb-node enroll` as the agent user with a token file; its result. */
  async runEnroll(prepared: Omit<Node, 'nodeId' | 'token'>, token: string) {
    const tokenPath = join(prepared.state, 'token')
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 })
    await chown(tokenPath, prepared.uid, prepared.gid)
    try {
      const r = await run(
        join(this.dir, 'exponetdb-node'),
        ['enroll', '--config', prepared.configPath, '--token-file', tokenPath],
        { uid: prepared.uid, gid: prepared.gid, env: this.agentEnv },
      )
      return { ok: true as const, stdout: r.stdout, stderr: r.stderr }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number }
      return { ok: false as const, stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code }
    } finally {
      await rm(tokenPath, { force: true })
    }
  }

  /** Enrolls, trusts the helper, starts both and waits for the node to be active. */
  async enrollNode(revealed?: string): Promise<Node> {
    const prepared = await this.prepareNode()
    const token = revealed ?? (await this.enrollmentToken())
    const enrolled = await this.runEnroll(prepared, token)
    expect(enrolled.ok, enrolled.stderr).toBe(true)
    const nodeId = /enrolled as (nod_[0-9A-Z]{26})/.exec(enrolled.stdout)?.[1] ?? ''
    expect(nodeId).not.toBe('')
    await run(
      join(this.dir, 'exponetdb-node-helper'),
      ['trust', '--agent-state', prepared.state, '--trust', prepared.trustPath],
      { env: this.agentEnv },
    )
    this.node = { ...prepared, nodeId, token }
    await this.startNodeProcesses()
    await eventually(
      'binding and the instance in hello',
      () => this.sql('SELECT state, clusters FROM nodes.nodes WHERE node_id = $1', [nodeId]),
      (rows) =>
        rows[0]?.state === 'active' &&
        Array.isArray(rows[0]?.clusters) &&
        rows[0].clusters.some(
          (c: { systemIdentifier: string }) => c.systemIdentifier === this.systemIdentifier,
        ),
    )
    return this.node
  }

  async startNodeProcesses(): Promise<void> {
    const node = this.requireNode()
    if (SYSTEMD) {
      await this.#startUnits(node)
      return
    }
    this.#spawnHelper()
    await eventually(
      'the helper socket',
      async () => existsSync(join(this.dir, 'run', 'helper.sock')),
      (v) => v,
    )
    this.#spawnAgent()
    this.#stops.push(async () => {
      this.#respawnAgent = false
      this.#respawnHelper = false
      this.#agent?.kill('SIGTERM')
      this.#helper?.kill('SIGTERM')
    })
  }

  #spawnHelper(): void {
    const node = this.requireNode()
    const p = spawn(
      join(this.dir, 'exponetdb-node-helper'),
      [
        'serve',
        '--config',
        node.configPath,
        '--trust',
        node.trustPath,
        '--state-dir',
        join(node.helperDir, 'state'),
      ],
      { env: { ...this.agentEnv, EXPONETDB_NODE_HELPER_E2E_FAULTS: node.helperFaults } },
    )
    p.stderr?.on('data', (c: Buffer) => this.lines.push(`helper: ${c.toString('utf8')}`))
    // Without systemd the test restarts a killed helper itself (socket activation would).
    p.on('exit', () => {
      if (this.#helper === p && this.#respawnHelper) {
        setTimeout(() => this.#respawnHelper && this.#spawnHelper(), 500)
      }
    })
    this.#helper = p
  }

  #spawnAgent(): void {
    const node = this.requireNode()
    const p = spawn(join(this.dir, 'exponetdb-node'), ['run', '--config', node.configPath], {
      uid: node.uid,
      gid: node.gid,
      env: { ...this.agentEnv, EXPONETDB_NODE_E2E_FAULTS: node.faults },
    })
    p.stderr?.on('data', (c: Buffer) => this.lines.push(`agent: ${c.toString('utf8')}`))
    // Without systemd the test restarts a crashed agent itself (Restart=on-failure).
    p.on('exit', () => {
      if (this.#agent === p && this.#respawnAgent) {
        setTimeout(() => this.#respawnAgent && this.#spawnAgent(), 1000)
      }
    })
    this.#agent = p
  }

  async stopAgent(): Promise<void> {
    if (SYSTEMD) {
      await run('systemctl', ['stop', `${this.#prefix}-node.service`])
      return
    }
    this.#respawnAgent = false
    const p = this.#agent
    if (p !== undefined && p.exitCode === null && p.signalCode === null) {
      const exited = new Promise((r) => p.once('exit', r))
      p.kill('SIGTERM')
      await exited
    }
  }

  async startAgent(): Promise<void> {
    if (SYSTEMD) {
      await run('systemctl', ['start', `${this.#prefix}-node.service`])
      return
    }
    this.#respawnAgent = true
    this.#spawnAgent()
  }

  async stopHelper(): Promise<void> {
    if (SYSTEMD) {
      await run('systemctl', [
        'stop',
        `${this.#prefix}-helper.service`,
        `${this.#prefix}-helper.socket`,
      ])
      return
    }
    this.#respawnHelper = false
    const p = this.#helper
    if (p !== undefined && p.exitCode === null && p.signalCode === null) {
      const exited = new Promise((r) => p.once('exit', r))
      p.kill('SIGTERM')
      await exited
    }
    await rm(join(this.dir, 'run', 'helper.sock'), { force: true })
  }

  async startHelper(): Promise<void> {
    if (SYSTEMD) {
      await run('systemctl', ['start', `${this.#prefix}-helper.socket`])
      return
    }
    this.#respawnHelper = true
    this.#spawnHelper()
    await eventually(
      'the helper socket',
      async () => existsSync(join(this.dir, 'run', 'helper.sock')),
      (v) => v,
    )
  }

  /** Installs the shipped units under /run/systemd/system with this world's paths and starts them. */
  async #startUnits(node: Node): Promise<void> {
    const group = (await run('id', ['-gn', this.agentUser])).stdout.trim()
    const clock = '[Service]\nEnvironment=EXPONETDB_NODE_E2E_CLOCK=synchronized'
    const faults = `${clock}\nEnvironment=EXPONETDB_NODE_E2E_FAULTS=${node.faults}`
    const helperFaults = `${clock}\nEnvironment=EXPONETDB_NODE_HELPER_E2E_FAULTS=${node.helperFaults}`
    const prefix = this.#prefix
    const socketName = `${prefix}-helper.socket`
    let agent = readFileSync(join(UNITS, 'exponetdb-node.service'), 'utf8')
    agent = swap(agent, /^User=exponetdb-node$/m, `User=${this.agentUser}`)
    agent = swap(agent, /^Group=exponetdb-node$/m, `Group=${group}`)
    agent = swap(
      agent,
      /^ExecStart=.*$/m,
      `ExecStart=${this.dir}/exponetdb-node run --config ${node.configPath}`,
    )
    agent = swap(agent, /^StateDirectory=.*\n/m, `ReadWritePaths=${node.state}\n`)
    agent = swap(agent, /^StateDirectoryMode=.*\n/m, '')
    agent = swap(agent, /^\[Service\]$/m, faults).replaceAll(
      'exponetdb-node-helper.socket',
      socketName,
    )
    let socket = readFileSync(join(UNITS, 'exponetdb-node-helper.socket'), 'utf8')
    socket = swap(socket, /^ListenStream=.*$/m, `ListenStream=${this.dir}/run/helper.sock`)
    socket = swap(socket, /^SocketGroup=.*$/m, `SocketGroup=${group}`)
    let helper = readFileSync(join(UNITS, 'exponetdb-node-helper.service'), 'utf8')
    helper = swap(
      helper,
      /^ExecStart=.*$/m,
      `ExecStart=${this.dir}/exponetdb-node-helper serve --config ${node.configPath} --trust ${node.trustPath} --state-dir ${node.helperDir}/state`,
    )
    helper = swap(
      helper,
      /^ReadWritePaths=.*$/m,
      `ReadWritePaths=/etc/postgresql ${node.helperDir}`,
    )
    helper = swap(helper, /^StateDirectory=.*\n/m, '')
    helper = swap(helper, /^StateDirectoryMode=.*\n/m, '')
    helper = swap(helper, /^\[Service\]$/m, helperFaults).replaceAll(
      'exponetdb-node-helper.socket',
      socketName,
    )
    const units = [`${prefix}-node.service`, `${prefix}-helper.service`, socketName]
    await writeFile(`/run/systemd/system/${prefix}-node.service`, agent)
    await writeFile(`/run/systemd/system/${prefix}-helper.service`, helper)
    await writeFile(`/run/systemd/system/${socketName}`, socket)
    this.#stops.push(async () => {
      await run('systemctl', ['stop', ...units]).catch(() => undefined)
      for (const unit of units) {
        await rm(`/run/systemd/system/${unit}`, { force: true })
      }
      await run('systemctl', ['daemon-reload'])
    })
    await run('systemctl', ['daemon-reload'])
    await run('systemctl', ['start', socketName])
    await run('systemctl', ['start', `${prefix}-node.service`])
  }

  async dispose(): Promise<void> {
    for (const stop of this.#stops.reverse()) {
      await stop().catch(() => undefined)
    }
    await this.db?.drop().catch(() => undefined)
    if (this.dir !== '') {
      await rm(this.dir, { recursive: true, force: true })
    }
  }
}

/**
 * Registers a host scenario: the preflight and the world before the tests,
 * a lab diagnosis after each failed test, the run record and the teardown
 * after them. Returns the world (built in `beforeAll`).
 */
export function hostScenario(options: HostWorldOptions & { readonly enroll?: boolean }): HostWorld {
  const world = new HostWorld(options.scenario)
  const startedAt = new Date().toISOString()
  const failed: string[] = []
  let labProblems: LabProblem[] = []
  let unavailable = false
  beforeAll(async () => {
    await writeRecord({
      schema: 'exponetdb.lab-scenario/v1',
      scenario: options.scenario,
      state: 'running',
      pid: process.pid,
      startedAt,
      endedAt: null,
      failedTests: [],
      labProblems: [],
    })
    try {
      await world.start(options)
      if (options.enroll ?? true) {
        await world.enrollNode()
      }
    } catch (error) {
      if (error instanceof LabUnavailable) {
        unavailable = true
        labProblems = [{ category: error.category, detail: error.message }]
      } else {
        labProblems = await labDiagnosis(17)
        if (labProblems.length > 0) {
          console.error(labReport(options.scenario, labProblems))
        }
      }
      throw error
    }
  }, 600_000)
  afterEach(async (context) => {
    if (context.task.result?.state !== 'fail') return
    failed.push(context.task.name)
    const problems = await labDiagnosis(17)
    labProblems = [...labProblems, ...problems]
    console.error(
      problems.length > 0
        ? labReport(options.scenario, problems)
        : `PRODUCT FAILURE suspected in ${options.scenario}: the lab checks passed after "${context.task.name}" failed`,
    )
    console.error(await world.logs().catch((e: unknown) => String(e)))
  })
  afterAll(async () => {
    await world.dispose()
    await writeRecord({
      schema: 'exponetdb.lab-scenario/v1',
      scenario: options.scenario,
      state: unavailable
        ? 'lab_unavailable'
        : failed.length > 0 || labProblems.length > 0
          ? 'failed'
          : 'passed',
      pid: process.pid,
      startedAt,
      endedAt: new Date().toISOString(),
      failedTests: failed,
      labProblems,
    })
  }, 300_000)
  return world
}

function labReport(scenario: string, problems: readonly LabProblem[]): string {
  return [
    `LAB FAILURE in ${scenario} (not a product failure until the lab is fixed and the scenario passes or fails again):`,
    ...problems.map((p) => `  - ${p.category}: ${p.detail}`),
  ].join('\n')
}
