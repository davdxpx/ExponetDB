import { operationView } from '@exponetdb/application'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type JsonObject, newId, systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  processNextOperation,
  readPlan,
} from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerDispatchAdmission, workerKinds } from '../src/composition/access.ts'
import { WORKER_TASKS } from '../src/composition/worker-tasks.ts'
import type { BackupExecutionConfig, ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import {
  enrollOwner,
  NodeFailure,
  ORIGIN,
  type Person,
  placeTarget,
  registryWorld,
  type SimulatedNode,
  simulatedNode,
  storeOf,
  type World,
} from './support/node-world.ts'

/**
 * Wave 9 Part B end to end (ADR-0036 to ADR-0038): the REST API of `serve`,
 * the worker's kinds and dispatch admission as `runWorker` composes them,
 * and a simulated node that answers the backup capabilities and signs what
 * it answers. Real PostgreSQL 17. No engine runs here: the node's answers
 * are fixtures; `packages/backups/test/runbook.lab.test.ts` runs pgBackRest.
 *
 * Installation activation: backups on nonprod, restores into scratch only.
 */

let db: MigratedTestDatabase
let keyring: Keyring
/** Every line the serve logger wrote (TC-013: a 5xx must say why). */
const logLines: string[] = []
let app: ReturnType<typeof createPublicApp>
let owner: Person
let registry: KindRegistry
let admit: DispatchAdmission

const EXECUTION: BackupExecutionConfig = { backups: 'nonprod', restores: 'scratch' }

const STATUS = {
  running: true,
  acceptingConnections: true,
  version: '17.6',
  postmasterStartTime: '2026-10-01T03:12:44Z',
  inRecovery: false,
  dataDirectory: '/var/lib/postgresql/17/main',
}

const FULL = '20261020-010000F'
const INCREMENTAL = '20261020-010000F_20261027-010000I'

/** What the simulated host's engine knows: its backups and the runs it started. */
interface Host {
  systemIdentifier: string
  labels: string[]
  runs: Map<string, { purpose: string; startJobId: string; label: string | null }>
  calls: string[]
  /** The label the next backup run reports (an existing one simulates engine-user state naming an old backup). */
  runLabel: string
  /** VC-061: the repository's key was changed, or the repository was deleted. */
  damage?: 'wrong_key' | 'deleted' | undefined
}

/** VC-061: what the agent states when the helper refuses at once (the run never started). */
function damaged(host: Host, capability: string): JsonObject | NodeFailure | undefined {
  if (host.damage === undefined) return undefined
  const code = host.damage === 'wrong_key' ? 'repository_unreadable' : 'repository_missing'
  switch (capability) {
    case 'backup.list@1':
      return host.damage === 'wrong_key'
        ? new NodeFailure([], `helper refused (${code}): pgBackRest's catalog is not readable`)
        : {
            ...listing(host),
            stanza: {
              status: 'missing',
              message: 'missing stanza path',
              systemIdentifier: null,
              cipher: 'unknown',
            },
            backups: [],
            archive: [],
          }
    case 'backup.run@1':
    case 'backup.verify@1':
    case 'restore.execute@1':
      return new NodeFailure(
        ['start_run:running'],
        `start_refused (${code}): the repository cannot be used`,
      )
    case 'restore.prepare@1':
      return {
        runId: 'x',
        scratchFree: true,
        port: 55401,
        spaceAvailableBytes: 10_000_000_000,
        spaceRequiredBytes: null,
        engineCanRead: false,
        walContinuous: null,
        refusals: [host.damage === 'wrong_key' ? 'engine_cannot_read' : 'repository_missing'],
      }
  }
  return undefined
}

function listing(host: Host): JsonObject {
  return {
    engineVersion: '2.60.0',
    stanza: {
      status: 'ok',
      message: 'ok',
      systemIdentifier: host.systemIdentifier,
      cipher: 'none',
    },
    backups: host.labels.map((label, i) => ({
      label,
      kind: label.endsWith('I') ? 'incremental' : 'full',
      startedAt: new Date(Date.UTC(2026, 9, 20 + i, 1)).toISOString(),
      finishedAt: new Date(Date.UTC(2026, 9, 20 + i, 1, 10)).toISOString(),
      lsnStart: '0/3000028',
      lsnStop: '0/3000100',
      walStart: `00000001000000000000000${3 + i}`,
      sizeBytes: 100_000_000 + i,
      repositorySizeBytes: 10_000_000,
      postgresMajor: 17,
      error: false,
    })),
    // The node listed the archive and found no hole (VC-005: an unlisted archive is not continuous).
    archive: [
      { id: '17-1', min: '000000010000000000000003', max: '000000010000000000000009', gapEnds: [] },
    ],
    truncated: false,
  }
}

function started(args: JsonObject): JsonObject {
  return {
    runId: args['runId'] as string,
    unit: `exponetdb-run-${String(args['runId'])}.service`,
    startedAt: new Date().toISOString(),
  }
}

function answer(host: Host) {
  return (
    capability: string,
    args: JsonObject,
    job: { readonly jobId: string },
  ): JsonObject | NodeFailure => {
    host.calls.push(capability)
    const runId = String(args['runId'] ?? '')
    const refused = damaged(host, capability)
    if (refused !== undefined) {
      return refused instanceof NodeFailure || capability !== 'restore.prepare@1'
        ? refused
        : { ...refused, runId }
    }
    switch (capability) {
      case 'postgres.status@1':
        return STATUS
      case 'backup.list@1':
        return listing(host)
      case 'wal.archive_status@1':
        // The archiver's last segment is the repository's newest (the listing's archive max).
        return {
          archiveMode: 'on',
          archivedCount: 9,
          failedCount: 0,
          lastArchivedWal: '000000010000000000000009',
          lastArchivedAt: new Date(Date.now() - 60_000).toISOString(),
          lastFailedWal: null,
          lastFailedAt: null,
        }
      case 'backup.run@1':
        host.runs.set(runId, { purpose: 'backup', startJobId: job.jobId, label: host.runLabel })
        return started(args)
      case 'backup.verify@1':
        host.runs.set(runId, { purpose: 'verify', startJobId: job.jobId, label: null })
        return started(args)
      case 'restore.prepare@1':
        return {
          runId,
          scratchFree: true,
          port: 55401,
          spaceAvailableBytes: 10_000_000_000,
          spaceRequiredBytes: 200_000_000,
          engineCanRead: true,
          walContinuous: true,
          refusals: [],
        }
      case 'restore.execute@1':
        startedRowCounts = args['rowCounts']
        host.runs.set(runId, { purpose: 'restore', startJobId: job.jobId, label: null })
        return started(args)
      case 'restore.discard@1':
        return { runId, removed: true, wasRunning: true }
      case 'run.status@1': {
        const run = host.runs.get(runId)
        if (run === undefined) {
          return statusOf(runId, null, 'not_found', null)
        }
        if (run.purpose === 'backup' && run.label !== null && !host.labels.includes(run.label)) {
          host.labels.push(run.label)
        }
        return statusOf(runId, run, 'succeeded', args)
      }
      default:
        throw new Error(`no answer for ${capability}`)
    }
  }
}

/** What the simulated node reports for the amcheck check of a restore (TC-010). */
let amcheckOutcome: 'passed' | 'not_run' | 'failed' = 'passed'
/**
 * Where the simulated replay stops: inside the newest archived segment
 * (000000010000000000000009), as a real replay of it does. VC-004: exactly at
 * its start means that segment was never replayed (deleted or unreadable).
 */
let replayReached = '0/9000060'
/** The row-count bounds the last restore start carried (VC-004). */
let startedRowCounts: unknown
const AMCHECK_DETAIL = '497 indexes checked in 3 of 5 databases; amcheck is missing in the others'

function statusOf(
  runId: string,
  run: { purpose: string; startJobId: string; label: string | null } | null,
  state: 'succeeded' | 'not_found',
  args: JsonObject | null,
): JsonObject {
  const at = new Date().toISOString()
  const earlier = new Date(Date.now() - 90_000).toISOString()
  return {
    runId,
    found: run !== null,
    startJobId: run === null ? null : String(args?.['startJobId']),
    startArgsHash: run === null ? null : String(args?.['startArgsHash']),
    purpose: (run?.purpose ?? null) as never,
    state,
    startedAt: run === null ? null : earlier,
    finishedAt: run === null ? null : at,
    exitCode: run === null ? null : 0,
    progress: null,
    excerpt: '',
    outcome:
      run === null
        ? null
        : {
            label: run.label,
            verifyErrors: run.purpose === 'verify' ? 0 : null,
            recoveryReachedLsn: run.purpose === 'restore' ? replayReached : null,
            recoveryReachedAt: run.purpose === 'restore' ? at : null,
            timeline: 1,
            port: run.purpose === 'restore' ? 55401 : null,
            checks:
              run.purpose === 'restore'
                ? [
                    'recovery_target_reached',
                    'probe_simple',
                    'probe_extended',
                    'amcheck',
                    // The node counts the tables it was given (VC-004).
                    ...(Array.isArray(startedRowCounts) && startedRowCounts.length > 0
                      ? ['row_counts']
                      : []),
                  ].map((check) =>
                    check === 'amcheck' && amcheckOutcome !== 'passed'
                      ? { check, outcome: amcheckOutcome, detail: AMCHECK_DETAIL }
                      : { check, outcome: 'passed', detail: null },
                  )
                : [],
            phases:
              run.purpose === 'restore'
                ? [
                    { name: 'restore', startedAt: earlier, finishedAt: at, outcome: 'passed' },
                    { name: 'recover', startedAt: at, finishedAt: at, outcome: 'passed' },
                  ]
                : [],
          },
  } as JsonObject
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_backups')
  const parsed = parseKeyring(generateKeyringText('test-key'))
  if (!parsed.ok) throw new Error('keyring')
  keyring = parsed.value
  const worker = storeOf(db, 'exdb_worker')
  await registerActiveKey(worker, keyring)
  await worker.transaction('test.pki', (tx) =>
    initPki(tx, keyring, systemClock, {
      gatewayUrl: 'https://10.8.2.2:7443',
      serverName: 'gateway.exdb.test',
    }),
  )
  const config: ServeConfig = {
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
    mcpAllowedOrigins: [],
    clientRegistration: 'review',
    backupExecution: EXECUTION,
  }
  const logger = createLogger({
    role: 'serve',
    level: 'warn',
    write: (line) => {
      logLines.push(line)
      if (process.env['EXDB_TEST_LOGS'] === '1') process.stderr.write(`${line}\n`)
    },
  })
  const access = composeAccess(
    config,
    { store: storeOf(db, 'exdb_serve'), keyring },
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
  owner = await enrollOwner(db, (input, init) => app.request(input, init))
  const kinds: readonly OperationKind[] = workerKinds(
    { store: worker, keyring },
    { clock: systemClock },
    db.installationId,
    EXECUTION,
  )
  registry = new KindRegistry(kinds)
  admit = workerDispatchAdmission(kinds, { clock: systemClock })
}, 180_000)

afterAll(async () => {
  await db?.drop()
})

async function drive() {
  for (let i = 0; i < 30; i++) {
    const r = await processNextOperation(storeOf(db, 'exdb_worker'), {
      workerId: newId('prc', Date.now()),
      kinds: registry,
      clock: systemClock,
      admit,
    })
    if (r.status === 'idle') return
  }
}

/** The detail of the operation's last event that names an error code (VC-061). */
async function errorDetail(operationId: string): Promise<JsonObject | undefined> {
  const r = await db.asSuperuser((c) =>
    c.query(
      `SELECT detail FROM operations.operation_events WHERE operation_id = $1 AND detail ? 'errorCode'
        ORDER BY event_id DESC LIMIT 1`,
      [operationId],
    ),
  )
  // The transition writes the outcome's detail beside its errorCode.
  return r.rows[0]?.detail as JsonObject | undefined
}

async function view(operationId: string) {
  return operationView(storeOf(db, 'exdb_serve'), operationId, ORIGIN)
}

/** A world on a tier, its node, a fresh status observation and the simulated host. */
async function setup(
  tier: 'prod' | 'nonprod',
): Promise<{ w: World; node: SimulatedNode; host: Host }> {
  const w = await registryWorld(db)
  await placeTarget(db, w, tier)
  const host: Host = {
    systemIdentifier: w.systemIdentifier,
    labels: [FULL],
    runs: new Map(),
    calls: [],
    runLabel: INCREMENTAL,
  }
  const node = await simulatedNode(db, keyring, w, answer(host))
  node.start()
  const inspected = await owner.browser.call('POST', `/api/v1/nodes/${node.nodeId}/inspections`, {
    capability: 'postgres.status@1',
    clusterId: w.clusterId,
    args: {},
  })
  expect([inspected.status, inspected.body?.code]).toEqual([202, undefined])
  await drive()
  return { w, node, host }
}

/** Plans, re-authenticates, applies and drives the worker; returns the operation's view. */
async function planAndApply(path: string, body: unknown) {
  const planned = await owner.browser.call('POST', path, body)
  expect([planned.status, planned.body?.code], JSON.stringify(planned.body)).toEqual([
    201,
    undefined,
  ])
  await owner.reauth()
  const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
  expect([applied.status, applied.body?.code], JSON.stringify(applied.body)).toEqual([
    202,
    undefined,
  ])
  await drive()
  if ((await view(applied.body.id)).state === 'awaiting_approval') {
    // Production: the person approves (one-person organization, OD-9), then the worker runs it.
    await owner.reauth()
    const approved = await owner.browser.call(
      'POST',
      `/api/v1/approvals/${applied.body.id}/approve`,
      {
        planHash: planned.body.planHash,
        acknowledgeSelfApproval: true,
      },
    )
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    await drive()
  }
  return { plan: planned.body, operation: await view(applied.body.id) }
}

/** One run of the worker's own task (VC-038): the generator had no caller outside this test. */
async function findingsPass() {
  const task = WORKER_TASKS.find((t) => t.name === 'backups.findings')
  if (task === undefined) throw new Error('the worker has no task backups.findings')
  await task.run({ store: storeOf(db, 'exdb_worker'), runtime: { clock: systemClock } } as never)
}

async function openFindings(clusterId: string): Promise<string[]> {
  const listed = await owner.browser.call(
    'GET',
    `/api/v1/clusters/${clusterId}/findings?state=open`,
  )
  expect(listed.status, JSON.stringify(listed.body)).toBe(200)
  return listed.body.items.map((f: { code: string }) => f.code)
}

const ADOPT = {
  layer: 'l1_physical',
  engine: 'pgbackrest',
  provider: 's3_compatible',
  location: {
    endpointHost: 'objects.storage-lab.net',
    region: 'eu-central',
    bucket: 'exdb-lab-backups',
    prefix: 'main/',
    stanza: 'main',
    repoIndex: 1,
  },
}

async function adopt(w: World): Promise<string> {
  const { operation } = await planAndApply(
    `/api/v1/clusters/${w.clusterId}/backup-repositories`,
    ADOPT,
  )
  expect(operation.state).toBe('succeeded')
  const list = await owner.browser.call(
    'GET',
    `/api/v1/clusters/${w.clusterId}/backup-repositories`,
  )
  expect(list.status).toBe(200)
  const repo = list.body.repositories[0]
  expect(repo).toMatchObject({
    ownership: 'adopted_observed',
    state: 'observing',
    secretSource: 'host_config',
    lock: { capability: 'unknown' },
  })
  return repo.id as string
}

async function refresh(w: World) {
  const refreshed = await owner.browser.call(
    'POST',
    `/api/v1/clusters/${w.clusterId}/backups/refresh`,
    {},
  )
  expect([refreshed.status, refreshed.body?.code], JSON.stringify(refreshed.body)).toEqual([
    202,
    undefined,
  ])
  await drive()
  return view(refreshed.body.id)
}

describe('backups through REST, the worker and a simulated node', () => {
  it('adopts a repository read-only, mirrors its catalog and never counts it protected', async () => {
    const { w, node, host } = await setup('nonprod')
    await adopt(w)
    // Adoption changed nothing on the host: no job ran for it.
    expect(host.calls.filter((c) => c !== 'postgres.status@1')).toEqual([])
    expect((await refresh(w)).state).toBe('succeeded')
    const catalog = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backups`)
    expect(catalog.status).toBe(200)
    expect(catalog.body.backups.map((b: { engineLabel: string }) => b.engineLabel)).toEqual([FULL])
    expect(catalog.body.protection.state).not.toBe('protected')
    expect(catalog.body.repositories[0]).toMatchObject({
      state: 'active',
      ownership: 'adopted_observed',
    })
    expect(JSON.stringify(catalog.body)).not.toContain('exdb-lab-backups')
    const overview = await owner.browser.call('GET', '/api/v1/backups/overview')
    expect(overview.status).toBe(200)
    expect(overview.body.clusters.map((c: { clusterId: string }) => c.clusterId)).toContain(
      w.clusterId,
    )
    await node.stop()
  })

  it('refuses a run on an observed repository, then takes incremental runs only after the ownership change', async () => {
    const { w, node, host } = await setup('nonprod')
    const repositoryId = await adopt(w)
    await refresh(w)
    // Observed only: the policy denies the plan.
    const denied = await owner.browser.call('POST', `/api/v1/clusters/${w.clusterId}/backup-runs`, {
      repositoryId,
      kind: 'incremental',
    })
    expect([denied.status, denied.body?.decision]).toEqual([201, 'deny'])
    const { operation } = await planAndApply(
      `/api/v1/backup-repositories/${repositoryId}/ownership`,
      {
        to: 'adopted_runs',
        acknowledge: { hostConfigurationUnchanged: true },
      },
    )
    expect(operation.state).toBe('succeeded')
    // A full backup would shorten the host's retention: denied on adopted_runs.
    const full = await owner.browser.call('POST', `/api/v1/clusters/${w.clusterId}/backup-runs`, {
      repositoryId,
      kind: 'full',
    })
    expect(full.body?.decision).toBe('deny')
    const run = await planAndApply(`/api/v1/clusters/${w.clusterId}/backup-runs`, {
      repositoryId,
      kind: 'incremental',
    })
    expect(run.operation).toMatchObject({ state: 'succeeded' })
    expect(host.calls).toContain('backup.run@1')
    const catalog = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backups`)
    expect(catalog.body.backups.map((b: { engineLabel: string }) => b.engineLabel)).toContain(
      INCREMENTAL,
    )
    const runs = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backup-runs`)
    expect(runs.body.runs[0]).toMatchObject({ purpose: 'backup', state: 'succeeded' })
    // `owned` needs a capability that does not exist: refused at planning.
    const owned = await owner.browser.call(
      'POST',
      `/api/v1/backup-repositories/${repositoryId}/ownership`,
      {
        to: 'owned',
        acknowledge: { hostConfigurationUnchanged: true },
      },
    )
    expect(owned.body?.code).toBe('CAPABILITY_UNAVAILABLE')
    await node.stop()
  })

  it('a run whose node names a backup that existed before it does not verify', async () => {
    const { w, node, host } = await setup('nonprod')
    const repositoryId = await adopt(w)
    await refresh(w)
    await planAndApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, {
      to: 'adopted_runs',
      acknowledge: { hostConfigurationUnchanged: true },
    })
    // The node's run statement names the full backup the catalog already held.
    host.runLabel = FULL
    const run = await planAndApply(`/api/v1/clusters/${w.clusterId}/backup-runs`, {
      repositoryId,
      kind: 'incremental',
    })
    expect(run.operation.state).not.toBe('succeeded')
    expect(run.operation).toMatchObject({ applyOutcome: 'applied', verificationOutcome: 'failed' })
    await node.stop()
  })

  it('a lost worker never leaves a run row open: no start job means the run is failed (review C-4)', async () => {
    const { w, node } = await setup('nonprod')
    const repositoryId = await adopt(w)
    await refresh(w)
    await planAndApply(`/api/v1/backup-repositories/${repositoryId}/ownership`, {
      to: 'adopted_runs',
      acknowledge: { hostConfigurationUnchanged: true },
    })
    const planned = await owner.browser.call(
      'POST',
      `/api/v1/clusters/${w.clusterId}/backup-runs`,
      {
        repositoryId,
        kind: 'incremental',
      },
    )
    await owner.reauth()
    const applied = await owner.browser.call('POST', `/api/v1/plans/${planned.body.id}/apply`, {})
    expect(applied.status).toBe(202)
    const worker = storeOf(db, 'exdb_worker')
    const plan = await readPlan(worker, planned.body.id)
    if (plan === undefined) throw new Error('plan')
    const runId = String((plan.body['content'] as Record<string, unknown>)['runId'])
    // The worker inserted the run row and died before it created the start job.
    await worker.query(
      'test.run_row',
      `INSERT INTO backups.runs (run_id, cluster_id, repository_id, node_id, purpose, kind, operation_id, state)
       VALUES ($1, $2, $3, $4, 'backup', 'incremental', $5, 'starting')`,
      [runId, w.clusterId, repositoryId, node.nodeId, applied.body.id],
    )
    const kind = registry.get('backup.run')
    if (kind === undefined) throw new Error('kind')
    const outcome = await kind.reconcile({
      plan,
      operationId: applied.body.id,
      signal: new AbortController().signal,
      leaseOwner: newId('prc', Date.now()),
    } as never)
    expect(outcome).toBe('not_applied')
    const row = await db.asSuperuser((c) =>
      c.query('SELECT state, error_code FROM backups.runs WHERE run_id = $1', [runId]),
    )
    expect(row.rows[0]).toMatchObject({ state: 'failed', error_code: 'NOT_STARTED' })
    await node.stop()
  })

  it('refuses a production backup run while only nonprod runs are activated', async () => {
    const { w, node } = await setup('prod')
    const repositoryId = await adopt(w)
    const refused = await owner.browser.call(
      'POST',
      `/api/v1/clusters/${w.clusterId}/backup-runs`,
      {
        repositoryId,
        kind: 'incremental',
      },
    )
    expect([refused.status, refused.body?.code]).toEqual([409, 'FEATURE_NOT_ACTIVATED'])
    expect(refused.body.details).toMatchObject({
      setting: 'EXPONETDB_BACKUP_EXECUTION',
      current: 'nonprod',
    })
    await node.stop()
  })

  it('verifies a backup, drills into scratch, discards it and measures the RTO; a recovery stays refused', async () => {
    const { w, node, host } = await setup('nonprod')
    const repositoryId = await adopt(w)
    await refresh(w)
    // A policy with a drill cadence: without a passed drill the worker opens a finding.
    const policy = await planAndApply(`/api/v1/clusters/${w.clusterId}/backup-policy`, {
      schedules: [],
      retention: { fullCount: 2, differentialCount: null, logicalDays: null },
      archiveTimeoutSeconds: 60,
      objectives: { rpoSeconds: 900, rtoSeconds: 3600 },
      drillCadenceDays: 30,
    })
    expect(policy.operation.state).toBe('succeeded')
    await findingsPass()
    expect(await openFindings(w.clusterId)).toContain('backup_drill_never_run')
    // Seen again by the next task run, the open finding is not written again (the review of group H).
    const version = async () =>
      (
        await db.asSuperuser((c) =>
          c.query(
            `SELECT xmin::text || '/' || xmax::text || '/' || occurrences AS v FROM observation.subject_findings
              WHERE cluster_id = $1 AND code = 'backup_drill_never_run' AND state = 'open'`,
            [w.clusterId],
          ),
        )
      ).rows[0]?.v
    const before = await version()
    expect(before).toBeDefined()
    await findingsPass()
    expect(await version()).toBe(before)
    const catalog = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backups`)
    const backupId = catalog.body.backups[0].id as string
    // A drill from an unverified backup is denied by restore.source-verified.
    const early = await owner.browser.call('POST', `/api/v1/clusters/${w.clusterId}/drills`, {
      repositoryId,
      selection: { kind: 'latest' },
    })
    expect(early.body?.decision).toBe('deny')
    const verified = await owner.browser.call(
      'POST',
      `/api/v1/clusters/${w.clusterId}/backups/${backupId}/verify`,
      {},
    )
    expect([verified.status, verified.body?.code], JSON.stringify(verified.body)).toEqual([
      202,
      undefined,
    ])
    await drive()
    expect((await view(verified.body.id)).state).toBe('succeeded')
    const drill = await planAndApply(`/api/v1/clusters/${w.clusterId}/drills`, {
      repositoryId,
      selection: { kind: 'latest' },
    })
    expect(drill.operation.state).toBe('succeeded')
    expect(host.calls).toEqual(
      expect.arrayContaining(['restore.prepare@1', 'restore.execute@1', 'restore.discard@1']),
    )
    // The passed drill resolves the finding.
    await findingsPass()
    expect(await openFindings(w.clusterId)).not.toContain('backup_drill_never_run')
    const drills = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/drills`)
    expect(drills.body.drills[0]).toMatchObject({ mode: 'control_plane', outcome: 'passed' })
    expect(drills.body.drills[0].measuredRtoSeconds).toBeGreaterThan(0)
    const restores = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/restores`)
    const restore = restores.body.restores[0]
    expect(restore).toMatchObject({ purpose: 'drill', state: 'discarded' })
    // The fingerprint and the ledger head are not checked in V1, and say so.
    expect(restore.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'fingerprint', outcome: 'not_run' }),
        expect.objectContaining({ check: 'ledger_head', outcome: 'not_run' }),
      ]),
    )
    // Restores are activated for scratch only: a recovery plan is refused.
    const target = await db.asSuperuser((c) =>
      c.query(
        `SELECT t.target_id FROM registry.targets t JOIN registry.placements p USING (target_id)
           JOIN registry.databases d USING (database_id) WHERE d.cluster_id = $1`,
        [w.clusterId],
      ),
    )
    const recovery = await owner.browser.call(
      'POST',
      `/api/v1/targets/${String(target.rows[0]?.target_id)}/restore-plans`,
      {
        purpose: 'recovery',
        repositoryId,
        source: { latest: true },
        destination: { kind: 'new_cluster', nodeId: node.nodeId },
        reason: 'incident test',
      },
    )
    // The plan can be reviewed (the data-loss window during an incident); its apply would be refused.
    expect([recovery.status, recovery.body?.code], JSON.stringify(recovery.body)).toEqual([
      201,
      undefined,
    ])
    expect(String(recovery.body.change?.analysis?.activation)).toMatch(/^not activated/)
    await node.stop()
  })

  it('offers a random point in time after a refresh alone: the refresh records the archive time (VC-062)', async () => {
    const { w, node, host } = await setup('nonprod')
    const repositoryId = await adopt(w)
    // No wal.archive_status@1 inspection before: the refresh reads it itself.
    expect((await refresh(w)).state).toBe('succeeded')
    expect(host.calls).toContain('wal.archive_status@1')
    const catalog = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backups`)
    const backupId = catalog.body.backups[0].id as string
    const verified = await owner.browser.call(
      'POST',
      `/api/v1/clusters/${w.clusterId}/backups/${backupId}/verify`,
      {},
    )
    expect(verified.status, JSON.stringify(verified.body)).toBe(202)
    await drive()
    expect((await view(verified.body.id)).state).toBe('succeeded')
    const planned = await owner.browser.call('POST', `/api/v1/clusters/${w.clusterId}/drills`, {
      repositoryId,
      selection: { kind: 'pitr_random' },
    })
    expect(
      [planned.status, planned.body?.code, planned.body?.decision],
      JSON.stringify(planned.body),
    ).toEqual([201, undefined, 'allow'])
    await node.stop()
  })

  it('ends a verification, a refresh and a drill at once with a named code on a wrong key or a deleted repository (VC-061)', async () => {
    const { w, node, host } = await setup('nonprod')
    const repositoryId = await adopt(w)
    await refresh(w)
    const catalog = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backups`)
    const backupId = catalog.body.backups[0].id as string
    const verifyOnce = async () => {
      const verified = await owner.browser.call(
        'POST',
        `/api/v1/clusters/${w.clusterId}/backups/${backupId}/verify`,
        {},
      )
      expect([verified.status, verified.body?.code], JSON.stringify(verified.body)).toEqual([
        202,
        undefined,
      ])
      const started = Date.now()
      await drive()
      return { operation: await view(verified.body.id), seconds: (Date.now() - started) / 1000 }
    }
    // A passed verification first: the drill below is allowed.
    expect((await verifyOnce()).operation.state).toBe('succeeded')

    for (const [damage, reason] of [
      ['wrong_key', 'repository_unreadable'],
      ['deleted', 'repository_missing'],
    ] as const) {
      host.damage = damage
      host.calls.length = 0
      const { operation, seconds } = await verifyOnce()
      expect(
        [
          operation.state,
          operation.applyOutcome,
          operation.errorCode,
          (await errorDetail(operation.id))?.['reason'],
        ],
        `${damage}: ${JSON.stringify(operation)}`,
      ).toEqual(['failed', 'not_applied', 'BACKUP_REPOSITORY_UNAVAILABLE', reason])
      // The refusal ends it: no wait for a run that never began.
      expect(seconds).toBeLessThan(20)
      expect(host.calls).not.toContain('run.status@1')
      const refreshed = await refresh(w)
      const repositories = (await errorDetail(refreshed.id))?.['repositories']
      expect(
        [refreshed.state, refreshed.errorCode, repositories],
        `${damage}: ${JSON.stringify(refreshed)}`,
      ).toEqual([
        'failed',
        'BACKUP_REPOSITORY_UNAVAILABLE',
        [{ repositoryId, errorCode: 'BACKUP_REPOSITORY_UNAVAILABLE', reason }],
      ])
    }
    // A drill on the deleted repository names it missing, not a foreign stanza.
    const drill = await planAndApply(`/api/v1/clusters/${w.clusterId}/drills`, {
      repositoryId,
      selection: { kind: 'latest' },
    })
    expect(
      [
        drill.operation.state,
        drill.operation.errorCode,
        (await errorDetail(drill.operation.id))?.['refusals'],
      ],
      JSON.stringify(drill.operation),
    ).toEqual(['failed', 'BACKUP_REPOSITORY_UNAVAILABLE', ['repository_missing']])
    host.damage = undefined
    await node.stop()
  })

  it('passes a drill whose amcheck was not run where the extension is missing, and fails one whose amcheck failed (TC-010, D-02)', async () => {
    const { w, node } = await setup('nonprod')
    const repositoryId = await adopt(w)
    await refresh(w)
    const catalog = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backups`)
    const backupId = catalog.body.backups[0].id as string
    const verified = await owner.browser.call(
      'POST',
      `/api/v1/clusters/${w.clusterId}/backups/${backupId}/verify`,
      {},
    )
    expect(verified.status).toBe(202)
    await drive()
    const drillOutcomes: string[] = []
    try {
      for (const outcome of ['not_run', 'failed'] as const) {
        amcheckOutcome = outcome
        const drill = await planAndApply(`/api/v1/clusters/${w.clusterId}/drills`, {
          repositoryId,
          selection: { kind: 'latest' },
        })
        drillOutcomes.push(`${outcome}:${drill.operation.state}`)
        const restores = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/restores`)
        // The newest restore first: the amcheck check keeps its outcome and its detail, whatever the drill's.
        expect(restores.body.restores[0].checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ check: 'amcheck', outcome, detail: AMCHECK_DETAIL }),
          ]),
        )
      }
    } finally {
      amcheckOutcome = 'passed'
    }
    expect(drillOutcomes).toEqual(['not_run:succeeded', 'failed:verification_failed'])
    const drills = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/drills`)
    expect(drills.body.drills.map((d: { outcome: string }) => d.outcome).slice(0, 2)).toEqual([
      'failed',
      'passed',
    ])
    await node.stop()
  })

  // VC-004: with the newest archived segment deleted the drill passed with committed data missing.
  it('fails a drill whose replay stopped at the start of the newest archived segment, and carries row-count bounds to the node', async () => {
    const { w, node } = await setup('nonprod')
    const repositoryId = await adopt(w)
    await refresh(w)
    const catalog = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/backups`)
    const backupId = catalog.body.backups[0].id as string
    await owner.browser.call(
      'POST',
      `/api/v1/clusters/${w.clusterId}/backups/${backupId}/verify`,
      {},
    )
    await drive()
    try {
      replayReached = '0/9000000'
      const short = await planAndApply(`/api/v1/clusters/${w.clusterId}/drills`, {
        repositoryId,
        selection: { kind: 'latest' },
      })
      expect(short.operation.state).toBe('verification_failed')
      const restores = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/restores`)
      expect(restores.body.restores[0].checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ check: 'recovery_target_reached', outcome: 'failed' }),
        ]),
      )
    } finally {
      replayReached = '0/9000060'
    }
    const bounds = [{ database: 'app', schema: 'public', table: 'orders', min: 1000, max: 2000 }]
    const counted = await planAndApply(`/api/v1/clusters/${w.clusterId}/drills`, {
      repositoryId,
      selection: { kind: 'latest' },
      rowCounts: bounds,
    })
    expect(counted.operation.state).toBe('succeeded')
    expect(startedRowCounts).toEqual(bounds)
    // VC-004 review: bounds the node would refuse are refused at planning, never after the start.
    for (const bad of [
      { database: 'app', schema: 'public', table: 'Orders', min: 1, max: 2 },
      { database: 'app', schema: 'pub$lic', table: 'orders', min: 1, max: 2 },
      { database: 'app', schema: 'public', table: 'orders', min: 3, max: 2 },
    ]) {
      const refused = await owner.browser.call('POST', `/api/v1/clusters/${w.clusterId}/drills`, {
        repositoryId,
        selection: { kind: 'latest' },
        rowCounts: [bad],
      })
      expect([refused.status, refused.body?.code], JSON.stringify(bad)).toEqual([
        422,
        'VALIDATION_FAILED',
      ])
    }
    await node.stop()
  })

  it('records an offline drill as an attestation: 201, listed, audited, with the real role set (TC-013, D-09)', async () => {
    const { w, node } = await setup('nonprod')
    const repositoryId = await adopt(w)
    const runbook = await owner.browser.call(
      'GET',
      `/api/v1/clusters/${w.clusterId}/restore-runbook?repository=${repositoryId}`,
    )
    expect(runbook.status, JSON.stringify(runbook.body)).toBe(200)
    const attest = (over: Record<string, unknown> = {}) =>
      owner.browser.call('POST', `/api/v1/clusters/${w.clusterId}/drills/offline`, {
        repositoryId,
        runbookDigest: runbook.body.digest,
        restoredAt: new Date(Date.now() - 60_000).toISOString(),
        durationSeconds: 1800,
        outcome: 'passed',
        notes: 'Restored on a spare host from the downloaded runbook; 370 of 370 rows.',
        ...over,
      })
    await owner.reauth()
    // The digest of another repository's runbook is refused before anything is written.
    const wrong = await attest({ runbookDigest: `sha256:${'0'.repeat(64)}` })
    expect([wrong.status, wrong.body?.code]).toEqual([422, 'VALIDATION_FAILED'])
    // VC-104: a restore time ahead of the database clock is a refusal that names the member, not
    // the 500 of the database's own exception.
    const ahead = await attest({
      restoredAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    })
    expect([ahead.status, ahead.body?.code]).toEqual([422, 'VALIDATION_FAILED'])
    expect(ahead.body?.details?.errors?.[0]).toMatchObject({ path: '/restoredAt', code: 'invalid' })
    await owner.reauth()
    const passed = await attest()
    expect([passed.status, passed.body?.code], JSON.stringify(passed.body)).toEqual([
      201,
      undefined,
    ])
    expect(passed.body).toMatchObject({
      mode: 'offline_runbook',
      outcome: 'attested',
      repositoryId,
      measuredRtoSeconds: null,
    })
    await owner.reauth()
    const failed = await attest({
      outcome: 'failed',
      notes: 'The restore stopped: wrong passphrase.',
    })
    expect([failed.status, failed.body?.code]).toEqual([201, undefined])
    expect(failed.body).toMatchObject({ mode: 'offline_runbook', outcome: 'failed' })
    // Listed as an attestation, not a measured pass; the audit row names it.
    const drills = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/drills`)
    expect(
      drills.body.drills.map((d: { mode: string; outcome: string }) => `${d.mode}:${d.outcome}`),
    ).toEqual(expect.arrayContaining(['offline_runbook:attested', 'offline_runbook:failed']))
    const audit = await db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'restore.drill.offline.recorded'`,
      ),
    )
    expect(Number(audit.rows[0]?.n)).toBeGreaterThanOrEqual(2)

    // And a 5xx says why: take the function away from serve, as it was missing before, and the
    // answer is a plain INTERNAL while the log names the error, its code and the route.
    const signature =
      'backups.record_offline_drill(text, text, text, text, text, text, text, timestamptz, timestamptz)'
    await db.asSuperuser((c) => c.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM exdb_serve`))
    try {
      await owner.reauth()
      logLines.length = 0
      const broken = await attest({ notes: 'The function is gone.' })
      expect([broken.status, broken.body?.code]).toEqual([500, 'INTERNAL'])
      const logged = logLines.filter(
        (l) => l.includes('http.request_failed') && l.includes('/drills/offline'),
      )
      expect(logged, logLines.join('\n')).toHaveLength(1)
      expect(JSON.parse(logged[0] ?? '{}')).toMatchObject({
        errorName: 'ControlStoreError',
        errorCode: 'control_store_permission_denied',
        causeCode: '42501',
      })
      expect(logged[0]).not.toContain(String(runbook.body.digest))
    } finally {
      await db.asSuperuser((c) => c.query(`GRANT EXECUTE ON FUNCTION ${signature} TO exdb_serve`))
    }
    await node.stop()
  })

  it('blocks the cluster retirement while a repository is live and gives an audited runbook without secrets', async () => {
    const { w, node } = await setup('nonprod')
    const repositoryId = await adopt(w)
    const preflight = await owner.browser.call('GET', `/api/v1/clusters/${w.clusterId}/retirement`)
    expect(preflight.status).toBe(200)
    const backups = preflight.body.providers.find(
      (p: { provider: string }) => p.provider === 'backups',
    )
    expect(backups.state).toBe('blocking')
    // Ids and states only: never the bucket, the prefix or a key.
    expect(backups.dependencies).toEqual([
      { kind: 'repository', id: repositoryId, state: 'observing', reason: 'repository_live' },
    ])
    expect(JSON.stringify(preflight.body)).not.toContain('exdb-lab-backups')
    const runbook = await owner.browser.call(
      'GET',
      `/api/v1/clusters/${w.clusterId}/restore-runbook?repository=${repositoryId}`,
    )
    expect(runbook.status, JSON.stringify(runbook.body)).toBe(200)
    expect(runbook.body.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(runbook.body.script).toContain('pgbackrest')
    expect(runbook.body.script).not.toMatch(/AKIA|secret_access_key\s*=/i)
    const audit = await db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'backup.runbook.downloaded'`,
      ),
    )
    expect(Number(audit.rows[0]?.n)).toBeGreaterThan(0)
    await node.stop()
  })
})

describe("the worker's dispatch re-check", () => {
  it('stops a verification, a catalog refresh and an agent adoption whose authority is gone (review F-6)', async () => {
    const w = await registryWorld(db)
    await placeTarget(db, w, 'nonprod')
    // A person who holds nothing (a revoked grant): the covered kinds are refused before they start.
    const actor = {
      kind: 'human',
      identityId: newId('idn', Date.now()),
      client: 'web',
      clientId: null,
    }
    const decide = (kind: string) =>
      storeOf(db, 'exdb_worker').transaction('test.dispatch_admission', (tx) =>
        admit(
          tx,
          {
            planId: newId('pln', Date.now()),
            kind,
            actionClass: 'low',
            actor,
            body: { subject: { clusterId: w.clusterId, tier: 'nonprod' } },
          } as never,
          { operationId: newId('op', Date.now()) } as never,
        ),
      )
    for (const kind of [
      'backup.verify',
      'backup.catalog.refresh',
      'registry.cluster.adopt_agent',
    ]) {
      expect(await decide(kind), kind).toEqual([{ binding: 'authorization', actual: 'revoked' }])
    }
    // A kind outside the list is not re-checked here (its own apply checks hold).
    expect(await decide('registry.test')).toEqual([])
  })
})
