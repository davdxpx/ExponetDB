import { operationView } from '@exponetdb/application'
import { maintainDrillFindings } from '@exponetdb/backups'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type JsonObject, newId, systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import { createLogger, MetricsRegistry } from '@exponetdb/observability'
import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  processNextOperation,
} from '@exponetdb/operations'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeAccess, workerDispatchAdmission, workerKinds } from '../src/composition/access.ts'
import type { BackupExecutionConfig, ServeConfig } from '../src/config/env.ts'
import { createPublicApp, httpMetrics } from '../src/interfaces/http/app.ts'
import {
  enrollOwner,
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
    archive: [{ id: '17-1', min: '000000010000000000000003', max: '000000010000000000000009' }],
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
  return (capability: string, args: JsonObject, job: { readonly jobId: string }): JsonObject => {
    host.calls.push(capability)
    const runId = String(args['runId'] ?? '')
    switch (capability) {
      case 'postgres.status@1':
        return STATUS
      case 'backup.list@1':
        return listing(host)
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
            recoveryReachedLsn: run.purpose === 'restore' ? '0/9000000' : null,
            recoveryReachedAt: run.purpose === 'restore' ? at : null,
            timeline: 1,
            port: run.purpose === 'restore' ? 55401 : null,
            checks:
              run.purpose === 'restore'
                ? ['recovery_target_reached', 'probe_simple', 'probe_extended', 'amcheck'].map(
                    (check) => ({ check, outcome: 'passed', detail: null }),
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

async function findingsPass() {
  await storeOf(db, 'exdb_worker').transaction('test.drill_findings', (tx) =>
    maintainDrillFindings(tx, Date.now()),
  )
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
