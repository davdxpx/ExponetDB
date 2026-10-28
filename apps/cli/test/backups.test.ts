import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTE_LIST } from '@exponetdb/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT } from '../src/cli/exit.ts'
import { COMMANDS } from '../src/commands/index.ts'
import { run } from '../src/main.ts'
import { SCOPE_PRESETS } from '../src/presets.ts'
import { testIo } from './support.ts'

/**
 * The Wave 9 Part B commands (backups, restores, drills, statistics,
 * advisors, findings, session actions) against a fake server behind a fake
 * `fetch`: every answer is checked against the route's response schema
 * before it is served (as the CLI checks it), every request is recorded.
 * Proves argument parsing, the request bodies, the refusals of missing
 * acknowledgements (nothing is sent), the runbook file rules (new file,
 * 0700, never overwritten, digest checked), the shown error codes and that
 * untrusted text reaches the terminal inert.
 */
const SERVER = 'https://db.example.test'
const ROUTES = new Map(ROUTE_LIST.map((r) => [r.operationId, r]))

const id = (prefix: string, n: number) => `${prefix}_01J${String(n).padStart(23, '0')}`
const CLS = id('cls', 1)
const BKR = id('bkr', 2)
const BKP = id('bkp', 3)
const NOD = id('nod', 4)
const RST = id('rst', 5)
const TGT = id('tgt', 6)
const T = '2026-10-26T10:00:00.000Z'
const HASH = `sha256:${'a'.repeat(64)}`

interface Recorded {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly body: unknown
  readonly headers: Record<string, string>
}

type Answer = readonly [status: number, body: unknown, operationId?: string]
type Handler = (req: Recorded) => Answer

let dir = ''
let requests: Recorded[] = []
let handlers: Map<string, Handler>

/** Registers an answer for `METHOD /path` (the path under /api/v1). */
function on(method: string, path: string, handler: Handler | Answer) {
  handlers.set(`${method} ${path}`, typeof handler === 'function' ? handler : () => handler)
}

/** A success body, checked against the operation's response schema first. */
function ok(operationId: string, body: unknown): Answer {
  const route = ROUTES.get(operationId)
  if (route === undefined) throw new Error(`no route ${operationId}`)
  const parsed = route.response.schema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`fixture for ${operationId} is invalid: ${JSON.stringify(parsed.error.issues)}`)
  }
  return [route.response.status, body, operationId]
}

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}): Answer => [
  status,
  { code, title: code, message: `Refused: ${code}.`, retryable: false, ...extra },
]

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
    headers[k.toLowerCase()] = v
  }
  const path = url.pathname.replace(/^\/api\/v1/, '')
  const method = init?.method ?? 'GET'
  const req: Recorded = {
    method,
    path,
    query: url.searchParams,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    headers,
  }
  if (path === '/installation') {
    return Response.json({
      version: '0.9.0',
      contracts: {
        restApi: 'v1',
        mcpCatalog: 'exponetdb.mcp/v1',
        nodeProtocol: 'exponetdb.node/v1',
        migrationManifest: 'exponetdb.migration/v1',
        projectConfig: 'exponetdb.project/v1',
      },
      features: [],
    })
  }
  requests.push(req)
  const handler = handlers.get(`${method} ${path}`)
  if (handler === undefined) return Response.json(refusal(404, 'NOT_FOUND')[1], { status: 404 })
  const [status, body] = handler(req)
  return Response.json(body, { status })
}

async function cli(argv: readonly string[], extra: Partial<Parameters<typeof testIo>[0]> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await run(
    argv,
    testIo({
      configDir: join(dir, 'config'),
      cwd: dir,
      fetch: fakeFetch,
      stdout,
      stderr,
      now: () => Date.parse('2026-10-26T12:00:00.000Z'),
      ...extra,
    }),
  )
  return { code, stdout: stdout.join(''), stderr: stderr.join('') }
}

async function json(argv: readonly string[]) {
  const out = await cli([...argv, '--output', 'json'])
  return { ...out, doc: JSON.parse(out.stdout) }
}

const sent = (method: string, path: string) =>
  requests.filter((r) => r.method === method && r.path === path)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'exdb-cli-b-'))
  requests = []
  handlers = new Map()
  const key = join(dir, 'k.txt')
  await writeFile(key, `exak_${'k'.repeat(32)}\n`)
  await chmod(key, 0o600)
  const add = await cli([
    'profile',
    'add',
    'lab',
    '--server',
    SERVER,
    '--auth',
    'api-key',
    '--key-file',
    key,
  ])
  expect(add.code, add.stderr).toBe(0)
  expect((await cli(['profile', 'use', 'lab'])).code).toBe(0)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// ----- fixtures -----

const actor = { identityId: id('idn', 7), kind: 'human', via: 'cli' } as const
const subject = { targetId: null, targetPath: null, clusterId: CLS, nodeId: null, tier: 'nonprod' }

function plan(operationId: string, kind: string, extra: Record<string, unknown> = {}) {
  return ok(operationId, {
    id: id('pln', 8),
    kind,
    kindVersion: 1,
    class: 'high',
    state: 'active',
    planHash: HASH,
    createdAt: T,
    expiresAt: T,
    actor,
    clientId: null,
    subject,
    contentChecksum: HASH,
    decision: 'allow',
    requirements: [],
    overriddenRules: [],
    approvals: { required: 0, given: 0 },
    ...extra,
  })
}

function operation(operationId: string, kind: string, state: string) {
  return ok(operationId, {
    id: id('op', 9),
    kind,
    planId: null,
    state,
    applyOutcome: state === 'succeeded' ? 'applied' : 'not_started',
    verificationOutcome: state === 'succeeded' ? 'passed' : 'pending',
    subject,
    actor,
    createdAt: T,
    updatedAt: T,
    waitingFor: null,
    approvalUrl: null,
    errorCode: null,
    steps: [],
  })
}

const protection = {
  state: 'at_risk',
  reasons: ['drill_never', 'lock_not_proven'],
  rpo: {
    achievableSeconds: 125,
    uncertaintySeconds: 60,
    basis: 'wal_archive',
    objectiveSeconds: 300,
  },
  rto: { measuredSeconds: null, drillId: null, drillAt: null, objectiveSeconds: null },
  pitrWindow: { from: T, to: T },
  lastVerifiedBackupAt: T,
  drill: { state: 'never', lastPassedAt: null, cadenceDays: 30 },
}

function backupEntry(n: number, label = 'pgbr-label') {
  return {
    id: id('bkp', 100 + n),
    repositoryId: BKR,
    engineLabel: label,
    kind: 'full',
    state: 'succeeded',
    startedAt: T,
    finishedAt: T,
    sizeBytes: 5 * 1024 * 1024,
    repositorySizeBytes: null,
    lsnStart: '0/3000028',
    lsnStop: '0/3000100',
    timeline: 1,
    postgresMajor: 17,
    engineVersion: '2.59.3',
    verification: { state: 'passed', verifiedAt: T },
    divergence: 'none',
    firstSeenAt: T,
    lastSeenAt: T,
  }
}

function catalog(backups: unknown[], nextCursor: string | null) {
  return ok('listClusterBackups', {
    clusterId: CLS,
    state: 'at_risk',
    backups,
    walWindow: { from: T, to: T },
    achievableRpoSeconds: 125,
    lastDrillAt: null,
    truncated: false,
    source: 'control_store',
    observedAt: T,
    repositories: [
      {
        id: BKR,
        layer: 'l1_physical',
        engine: 'pgbackrest',
        provider: 'hetzner_object_storage',
        ownership: 'adopted_observed',
        state: 'observing',
        lockCapability: 'unproven',
        reconciledAt: T,
      },
    ],
    protection,
    walCoverage: [],
    nextCursor,
  })
}

function runbook(
  script: string,
  digest = `sha256:${createHash('sha256').update(script).digest('hex')}`,
) {
  return ok('getRestoreRunbook', {
    clusterId: CLS,
    repositoryId: BKR,
    repositoryRevision: 3,
    filename: 'exponetdb-restore-main.sh',
    digest,
    script,
    placeholders: [
      { name: 'CIPHER_PASS_FILE', meaning: 'A file holding the repository passphrase.' },
    ],
    generatedAt: T,
  })
}

const SCRIPT = '#!/bin/sh\nset -eu\n# restore cls main from bkr\npgbackrest --stanza=main restore\n'

// ----- tests -----

describe('the registry', () => {
  it('declares the Wave 9 commands with their actions and keeps restore.execute out of every preset', () => {
    const byName = new Map(COMMANDS.map((c) => [c.path.join(' '), c]))
    const expected: Record<string, string> = {
      'backup overview': 'backup.overview',
      'backup list': 'backup.list',
      'backup repositories': 'backup.repository.list',
      'backup adopt': 'backup.repository.adopt.plan',
      'backup ownership': 'backup.repository.ownership.plan',
      'backup retire-repository': 'backup.repository.retire.plan',
      'backup policy show': 'backup.policy.get',
      'backup policy set': 'backup.policy.set.plan',
      'backup refresh': 'backup.catalog.refresh',
      'backup run': 'backup.run.plan',
      'backup verify': 'backup.verify',
      'backup runs': 'backup.run.list',
      'restore plan': 'restore.plan',
      'restore list': 'restore.list',
      'restore discard': 'restore.discard.plan',
      'restore runbook': 'restore.runbook.get',
      'drill plan': 'restore.drill.plan',
      'drill list': 'restore.list',
      'drill record-offline': 'restore.drill.offline.record',
      'diagnose query-stats': 'query_stats.list',
      'diagnose table-stats': 'table_stats.list',
      'diagnose advisors': 'advisor.run',
      'finding summary': 'finding.summary',
      'finding list': 'finding.list',
      'cluster findings': 'cluster.finding.list',
      'session list': 'session.list',
      'session cancel': 'connections.cancel',
      'session terminate': 'connections.terminate.plan',
    }
    for (const [name, action] of Object.entries(expected)) {
      expect(byName.get(name)?.action, name).toBe(action)
    }
    // No direct restore: a recovery plan offers no --apply, nothing executes a restore.
    const restorePlan = byName.get('restore plan')
    expect(restorePlan?.flags?.some((f) => f.name === 'apply')).toBe(false)
    expect(
      COMMANDS.some((c) => c.action === 'restore.recovery' || c.action === 'restore.execute'),
    ).toBe(false)
    // No bypass flag on any of them.
    for (const name of Object.keys(expected)) {
      expect(byName.get(name)?.flags?.some((f) => f.name === 'force') === true, name).toBe(false)
    }
    for (const preset of Object.values(SCOPE_PRESETS)) {
      expect(preset.scopes as readonly string[]).not.toContain('restore.execute')
    }
  })
})

describe('backup reads', () => {
  it('shows the overview with counts and passes the state filter', async () => {
    on(
      'GET',
      '/backups/overview',
      ok('getBackupOverview', {
        clusters: [
          {
            clusterId: CLS,
            serverId: null,
            displayName: 'main',
            managementMode: 'agent',
            repositories: 1,
            protection,
          },
        ],
        counts: { protected: 0, atRisk: 1, unprotected: 0, unproven: 0, unknown: 0 },
        nextCursor: null,
        source: 'inferred',
        observedAt: T,
      }),
    )
    const { code, doc } = await json(['backup', 'overview', '--state', 'at_risk'])
    expect(code).toBe(0)
    expect(sent('GET', '/backups/overview')[0]?.query.get('state')).toBe('at_risk')
    expect(doc.data.counts.atRisk).toBe(1)
    expect(doc.data.clusters[0].clusterId).toBe(CLS)
    const table = await cli(['backup', 'overview'])
    expect(table.stdout).toContain(CLS)
    expect(table.stdout).toContain('at_risk')
    expect(table.stdout).toContain('drill_never')
  })

  it('pages the catalog with a cursor, keeps the facts of the first page and offers the next page', async () => {
    on('GET', `/clusters/${CLS}/backups`, (req) =>
      req.query.get('cursor') === null
        ? catalog([backupEntry(1)], 'c2')
        : catalog([backupEntry(2)], null),
    )
    const all = await json(['backup', 'list', CLS, '--all'])
    expect(all.code).toBe(0)
    expect(all.doc.data.backups.map((b: { id: string }) => b.id)).toEqual([
      id('bkp', 101),
      id('bkp', 102),
    ])
    expect(all.doc.data.protection.state).toBe('at_risk')
    expect(sent('GET', `/clusters/${CLS}/backups`)[1]?.query.get('cursor')).toBe('c2')
    requests = []
    const one = await json(['backup', 'list', CLS, '--limit', '1'])
    expect(one.doc.data.backups).toHaveLength(1)
    expect(one.doc.next).toEqual([`exponetdb backup list ${CLS} --cursor c2`])
  })

  it('prints untrusted engine text inert in the table', async () => {
    on(
      'GET',
      `/clusters/${CLS}/backups`,
      catalog([backupEntry(1, 'x\u001b]52;c;cHduZWQ=\u0007y\u202e')], null),
    )
    const out = await cli(['backup', 'list', CLS])
    expect(out.code).toBe(0)
    for (const c of ['\u001b', '\u0007', '\u202e']) expect(out.stdout).not.toContain(c)
    expect(out.stdout).toContain('2m 5s ± 1m 0s')
    expect(out.stdout).toContain('5.0 MiB')
  })

  it('lists repositories without a location for a reader, and a policy that is not set', async () => {
    on(
      'GET',
      `/clusters/${CLS}/backup-repositories`,
      ok('listBackupRepositories', {
        clusterId: CLS,
        repositories: [
          {
            id: BKR,
            clusterId: CLS,
            layer: 'l1_physical',
            engine: 'pgbackrest',
            provider: 'cloudflare_r2',
            location: null,
            priority: 1,
            purpose: 'primary',
            ownership: 'adopted_observed',
            secretSource: 'host_config',
            lock: { mode: 'unknown', capability: 'unknown', retentionDays: null, provenAt: null },
            encryption: { cipher: 'aes-256-cbc', offlineCopyConfirmedAt: null },
            engineVersion: { pinned: null, observed: '2.58.0', advisory: 'below_floor' },
            state: 'observing',
            revision: 1,
            reconciliation: null,
            createdAt: T,
            retiredAt: null,
          },
        ],
        source: 'control_store',
        observedAt: T,
      }),
    )
    const repos = await cli(['backup', 'repositories', CLS])
    expect(repos.code).toBe(0)
    expect(repos.stdout).toContain('withheld')
    expect(repos.stdout).toContain('below_floor')
    on(
      'GET',
      `/clusters/${CLS}/backup-policy`,
      ok('getBackupPolicy', {
        clusterId: CLS,
        policy: null,
        source: 'control_store',
        observedAt: T,
      }),
    )
    const policy = await cli(['backup', 'policy', 'show', CLS])
    expect(policy.code).toBe(0)
    expect(policy.stdout).toContain('No backup policy is set.')
    expect(policy.stdout).toContain(`exponetdb backup policy set ${CLS} --file policy.yaml`)
  })

  it('lists runs, drills (an offline drill as an attestation) and restores', async () => {
    const list = (key: string, operationId: string, items: unknown[]) =>
      ok(operationId, {
        clusterId: CLS,
        [key]: items,
        nextCursor: null,
        source: 'control_store',
        observedAt: T,
      })
    on('GET', `/clusters/${CLS}/backup-runs`, list('runs', 'listBackupRuns', []))
    on(
      'GET',
      `/clusters/${CLS}/drills`,
      list('drills', 'listDrills', [
        {
          id: id('drl', 10),
          clusterId: CLS,
          restoreId: null,
          repositoryId: BKR,
          selection: 'latest',
          mode: 'offline_runbook',
          outcome: 'attested',
          measuredRtoSeconds: 900,
          startedAt: T,
          finishedAt: T,
        },
      ]),
    )
    on('GET', `/clusters/${CLS}/restores`, list('restores', 'listRestores', []))
    expect((await cli(['backup', 'runs', CLS])).stdout).toContain('No engine runs.')
    const drills = await cli(['drill', 'list', CLS])
    expect(drills.stdout).toContain('offline (attested)')
    expect(drills.stdout).toContain('15m 0s')
    expect((await cli(['restore', 'list', CLS])).stdout).toContain('No restores.')
  })
})

describe('backup plans', () => {
  it('plans adopted_runs only with the explicit host-configuration acknowledgement', async () => {
    on(
      'POST',
      `/backup-repositories/${BKR}/ownership`,
      plan('planBackupRepositoryOwnership', 'backup.repository.ownership'),
    )
    const missing = await cli(['backup', 'ownership', BKR, '--to', 'adopted_runs'])
    expect(missing.code).toBe(EXIT.usage)
    expect(missing.stderr).toContain('--host-configuration-unchanged')
    const no = await cli([
      'backup',
      'ownership',
      BKR,
      '--to',
      'adopted_runs',
      '--host-configuration-unchanged=false',
    ])
    expect(no.code).toBe(EXIT.usage)
    expect(sent('POST', `/backup-repositories/${BKR}/ownership`)).toHaveLength(0)
    const yes = await json([
      'backup',
      'ownership',
      BKR,
      '--to',
      'adopted_runs',
      '--host-configuration-unchanged',
    ])
    expect(yes.code).toBe(0)
    expect(yes.doc.planId).toBe(id('pln', 8))
    expect(sent('POST', `/backup-repositories/${BKR}/ownership`)[0]?.body).toEqual({
      to: 'adopted_runs',
      acknowledge: { hostConfigurationUnchanged: true },
    })
  })

  it('plans a repository retirement only with both acknowledgements', async () => {
    on(
      'POST',
      `/backup-repositories/${BKR}/retire`,
      plan('planBackupRepositoryRetirement', 'backup.repository.retire'),
    )
    for (const flags of [['--storage-kept'], ['--no-longer-protected'], []]) {
      const out = await cli(['backup', 'retire-repository', BKR, ...flags])
      expect(out.code, flags.join(' ')).toBe(EXIT.usage)
    }
    expect(sent('POST', `/backup-repositories/${BKR}/retire`)).toHaveLength(0)
    const out = await cli([
      'backup',
      'retire-repository',
      BKR,
      '--storage-kept',
      '--no-longer-protected',
      '--reason',
      'moved to another provider',
    ])
    expect(out.code, out.stderr).toBe(0)
    expect(sent('POST', `/backup-repositories/${BKR}/retire`)[0]?.body).toEqual({
      acknowledge: { storageKept: true, noLongerProtectedByExponetdb: true },
      reason: 'moved to another provider',
    })
  })

  it('takes an adoption and a policy only from a file checked against the contract', async () => {
    on(
      'POST',
      `/clusters/${CLS}/backup-repositories`,
      plan('planBackupRepositoryAdoption', 'backup.repository.adopt'),
    )
    const noFile = await cli(['backup', 'adopt', CLS])
    expect(noFile.code).toBe(EXIT.usage)
    expect(noFile.stderr).toContain('--file')
    const request = {
      layer: 'l1_physical',
      engine: 'pgbackrest',
      provider: 'hetzner_object_storage',
      location: {
        endpointHost: 'fsn1.your-objectstorage.com',
        region: 'fsn1',
        bucket: 'pg-backups',
        prefix: 'main/',
        stanza: 'main',
        repoIndex: 1,
      },
    }
    await writeFile(join(dir, 'bad.json'), JSON.stringify({ ...request, provider: 'posix' }))
    const bad = await cli(['backup', 'adopt', CLS, '--file', 'bad.json'])
    expect(bad.code).toBe(EXIT.usage)
    expect(bad.stderr).toContain('does not match the contract')
    expect(sent('POST', `/clusters/${CLS}/backup-repositories`)).toHaveLength(0)
    await writeFile(join(dir, 'repo.json'), JSON.stringify(request))
    const good = await cli(['backup', 'adopt', CLS, '--file', 'repo.json'])
    expect(good.code, good.stderr).toBe(0)
    expect(sent('POST', `/clusters/${CLS}/backup-repositories`)[0]?.body).toMatchObject({
      ...request,
      priority: 1,
      purpose: 'primary',
      declaredLockMode: 'unknown',
    })
    on('POST', `/clusters/${CLS}/backup-policy`, plan('planBackupPolicy', 'backup.policy.set'))
    await writeFile(
      join(dir, 'policy.yaml'),
      [
        'schedules:',
        '  - kind: full',
        `    repositoryId: ${BKR}`,
        '    cron: "0 2 * * 0"',
        '    enabled: true',
        'retention:',
        '  fullCount: 4',
        '  differentialCount: null',
        '  logicalDays: null',
        'archiveTimeoutSeconds: 60',
        'objectives:',
        '  rpoSeconds: 300',
        '  rtoSeconds: 3600',
        'drillCadenceDays: 30',
        '',
      ].join('\n'),
    )
    const policy = await cli(['backup', 'policy', 'set', CLS, '--file', 'policy.yaml'])
    expect(policy.code, policy.stderr).toBe(0)
    expect(sent('POST', `/clusters/${CLS}/backup-policy`)[0]?.body).toMatchObject({
      drillCadenceDays: 30,
      sizeFloorPercent: 50,
    })
  })

  it('plans a backup run and shows the server’s FEATURE_NOT_ACTIVATED with its remediation', async () => {
    on(
      'POST',
      `/clusters/${CLS}/backup-runs`,
      refusal(409, 'FEATURE_NOT_ACTIVATED', {
        remediation: 'Activate backup execution for this tier first.',
      }),
    )
    expect((await cli(['backup', 'run', CLS, '--repository', BKR, '--kind', 'weekly'])).code).toBe(
      EXIT.usage,
    )
    const out = await cli(['backup', 'run', CLS, '--repository', BKR, '--kind', 'incremental'])
    expect(out.code).toBe(EXIT.failure)
    expect(out.stderr).toContain('FEATURE_NOT_ACTIVATED')
    expect(out.stderr).toContain('Activate backup execution for this tier first.')
    expect(sent('POST', `/clusters/${CLS}/backup-runs`)[0]?.body).toEqual({
      repositoryId: BKR,
      kind: 'incremental',
    })
  })

  it('refreshes the catalog inline: waits by default, accepted with --no-wait', async () => {
    on(
      'POST',
      `/clusters/${CLS}/backups/refresh`,
      operation('refreshBackupCatalog', 'backup.catalog.refresh', 'queued'),
    )
    on(
      'GET',
      `/operations/${id('op', 9)}`,
      operation('getOperation', 'backup.catalog.refresh', 'succeeded'),
    )
    const waited = await cli(['backup', 'refresh', CLS])
    expect(waited.code, waited.stderr).toBe(0)
    expect(sent('POST', `/clusters/${CLS}/backups/refresh`)[0]?.headers['idempotency-key']).toMatch(
      /^[0-9a-f-]{36}$/,
    )
    expect(sent('GET', `/operations/${id('op', 9)}`).length).toBeGreaterThan(0)
    requests = []
    const accepted = await json(['backup', 'refresh', CLS, '--no-wait'])
    expect(accepted.code).toBe(0)
    expect(accepted.doc.status).toBe('accepted')
    expect(sent('GET', `/operations/${id('op', 9)}`)).toHaveLength(0)
  })

  it('verifies one backup inline', async () => {
    on(
      'POST',
      `/clusters/${CLS}/backups/${BKP}/verify`,
      operation('verifyBackup', 'backup.verify', 'succeeded'),
    )
    const out = await cli(['backup', 'verify', CLS, BKP])
    expect(out.code, out.stderr).toBe(0)
  })
})

describe('restores and drills', () => {
  it('plans a recovery from a file, shows the plan and never applies it', async () => {
    on('POST', `/targets/${TGT}/restore-plans`, plan('planRestore', 'restore.execute'))
    const withApply = await cli(['restore', 'plan', TGT, '--file', 'r.json', '--apply'])
    expect(withApply.code).toBe(EXIT.usage)
    expect((await cli(['restore', 'plan', TGT])).code).toBe(EXIT.usage)
    await writeFile(
      join(dir, 'r.json'),
      JSON.stringify({
        purpose: 'recovery',
        repositoryId: BKR,
        source: { pointInTime: T },
        destination: { kind: 'new_cluster', nodeId: NOD },
        reason: 'INC-42: table dropped by mistake',
      }),
    )
    const out = await json(['restore', 'plan', TGT, '--file', 'r.json'])
    expect(out.code, out.stderr).toBe(0)
    expect(out.doc.next).toEqual([`exponetdb plan apply ${id('pln', 8)} --wait`])
    expect(sent('POST', `/plans/${id('pln', 8)}/apply`)).toHaveLength(0)
    expect(sent('POST', `/targets/${TGT}/restore-plans`)).toHaveLength(1)
  })

  it('builds drill selections and refuses a malformed one before sending', async () => {
    on('POST', `/clusters/${CLS}/drills`, plan('planDrill', 'restore.drill'))
    const cases: [string, unknown][] = [
      ['latest', { kind: 'latest' }],
      ['pitr_random', { kind: 'pitr_random' }],
      [`backup:${BKP}`, { kind: 'backup', backupId: BKP }],
      [`pitr:${T}`, { kind: 'pitr', at: T }],
    ]
    for (const [selection, expected] of cases) {
      requests = []
      const out = await cli(['drill', 'plan', CLS, '--repository', BKR, '--selection', selection])
      expect(out.code, `${selection}: ${out.stderr}`).toBe(0)
      expect(sent('POST', `/clusters/${CLS}/drills`)[0]?.body).toEqual({
        repositoryId: BKR,
        selection: expected,
      })
    }
    requests = []
    for (const selection of ['newest', 'backup:not-an-id', 'pitr:yesterday']) {
      const out = await cli(['drill', 'plan', CLS, '--repository', BKR, '--selection', selection])
      expect(out.code, selection).toBe(EXIT.usage)
    }
    expect(sent('POST', `/clusters/${CLS}/drills`)).toHaveLength(0)
    const node = await cli([
      'drill',
      'plan',
      CLS,
      '--repository',
      BKR,
      '--selection',
      'older',
      '--node',
      NOD,
    ])
    expect(node.code).toBe(0)
    expect(sent('POST', `/clusters/${CLS}/drills`)[0]?.body).toMatchObject({ nodeId: NOD })
  })

  it('plans a discard of a scratch restore', async () => {
    on(
      'POST',
      `/clusters/${CLS}/restores/${RST}/discard`,
      plan('planRestoreDiscard', 'restore.discard'),
    )
    const out = await cli(['restore', 'discard', CLS, RST])
    expect(out.code, out.stderr).toBe(0)
    expect(sent('POST', `/clusters/${CLS}/restores/${RST}/discard`)[0]?.body).toEqual({})
  })

  it('records an offline drill from a file and names the Web App when a re-authentication is needed', async () => {
    const record = {
      repositoryId: BKR,
      runbookDigest: HASH,
      restoredAt: T,
      durationSeconds: 1200,
      outcome: 'passed',
      notes: 'Ran the runbook on a spare host; row counts matched.',
    }
    await writeFile(join(dir, 'drill.json'), JSON.stringify(record))
    expect((await cli(['drill', 'record-offline', CLS])).code).toBe(EXIT.usage)
    on('POST', `/clusters/${CLS}/drills/offline`, refusal(403, 'REAUTH_REQUIRED'))
    const refused = await cli(['drill', 'record-offline', CLS, '--file', 'drill.json'])
    expect(refused.code).toBe(EXIT.auth)
    expect(refused.stderr).toContain('REAUTH_REQUIRED')
    expect(refused.stderr).toContain('Web App')
    on(
      'POST',
      `/clusters/${CLS}/drills/offline`,
      ok('recordOfflineDrill', {
        id: id('drl', 11),
        clusterId: CLS,
        restoreId: null,
        repositoryId: BKR,
        selection: 'latest',
        mode: 'offline_runbook',
        outcome: 'attested',
        measuredRtoSeconds: 1200,
        startedAt: T,
        finishedAt: T,
      }),
    )
    const recorded = await cli(['drill', 'record-offline', CLS, '--file', 'drill.json'])
    expect(recorded.code, recorded.stderr).toBe(0)
    expect(recorded.stdout).toContain('attestation')
    expect(sent('POST', `/clusters/${CLS}/drills/offline`).at(-1)?.body).toEqual(record)
  })
})

describe('the restore runbook', () => {
  it('writes a new 0700 file, prints the digest and placeholders, and never overwrites', async () => {
    on('GET', `/clusters/${CLS}/restore-runbook`, runbook(SCRIPT))
    const out = await cli(['restore', 'runbook', CLS, '--repository', BKR, '--out', 'restore.sh'])
    expect(out.code, out.stderr).toBe(0)
    const path = join(dir, 'restore.sh')
    expect(await readFile(path, 'utf8')).toBe(SCRIPT)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o700)
    expect(out.stdout).toContain(`sha256:${createHash('sha256').update(SCRIPT).digest('hex')}`)
    expect(out.stdout).toContain('CIPHER_PASS_FILE')
    expect(sent('GET', `/clusters/${CLS}/restore-runbook`)[0]?.query.get('repository')).toBe(BKR)

    requests = []
    const again = await cli(['restore', 'runbook', CLS, '--repository', BKR, '--out', 'restore.sh'])
    expect(again.code).not.toBe(0)
    expect(again.stderr).toContain('already exists')
    // Refused before the (audited) download.
    expect(sent('GET', `/clusters/${CLS}/restore-runbook`)).toHaveLength(0)
    expect(await readFile(path, 'utf8')).toBe(SCRIPT)
  })

  it('refuses a runbook that does not match its digest and writes nothing', async () => {
    on('GET', `/clusters/${CLS}/restore-runbook`, runbook(SCRIPT, HASH))
    const out = await cli(['restore', 'runbook', CLS, '--repository', BKR, '--out', 'x.sh'])
    expect(out.code).toBe(EXIT.failure)
    expect(out.stderr).toContain('RUNBOOK_DIGEST_MISMATCH')
    await expect(stat(join(dir, 'x.sh'))).rejects.toThrow()
  })

  it('prints the script alone on stdout with --out -, the digest on stderr', async () => {
    on('GET', `/clusters/${CLS}/restore-runbook`, runbook(SCRIPT))
    const out = await cli(['restore', 'runbook', CLS, '--repository', BKR, '--out', '-'])
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toBe(SCRIPT)
    expect(out.stderr).toContain('Digest: sha256:')
    expect(out.stderr).toContain('Placeholder CIPHER_PASS_FILE')
    const asJson = await json(['restore', 'runbook', CLS, '--repository', BKR, '--out', '-'])
    expect(asJson.doc.data.script).toBe(SCRIPT)
  })

  it('shows a missing scope as the server named it', async () => {
    on(
      'GET',
      `/clusters/${CLS}/restore-runbook`,
      refusal(403, 'INSUFFICIENT_SCOPE', { details: { requiredScope: 'restore.plan' } }),
    )
    const out = await json(['restore', 'runbook', CLS, '--repository', BKR, '--out', 'y.sh'])
    expect(out.code).toBe(EXIT.auth)
    expect(out.doc.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(out.doc.error.details.requiredScope).toBe('restore.plan')
  })
})

describe('diagnostics', () => {
  it('reads query statistics with the window and order, and shows CAPABILITY_UNAVAILABLE', async () => {
    on(
      'GET',
      `/targets/${TGT}/query-stats`,
      refusal(409, 'CAPABILITY_UNAVAILABLE', {
        remediation: 'Install pg_stat_statements and add it to shared_preload_libraries.',
        details: { reason: 'extension_missing', extension: 'pg_stat_statements' },
      }),
    )
    const refused = await cli(['diagnose', 'query-stats', TGT])
    expect(refused.code).toBe(EXIT.failure)
    expect(refused.stderr).toContain('CAPABILITY_UNAVAILABLE')
    expect(refused.stderr).toContain('shared_preload_libraries')
    // The text output names the missing extension (TC-015), not only the generic message.
    expect(refused.stderr).toContain('extension: pg_stat_statements')
    expect(refused.stderr).toContain('reason: extension_missing')
    on(
      'GET',
      `/targets/${TGT}/query-stats`,
      ok('getQueryStats', {
        targetId: TGT,
        window: { from: T, to: T },
        statements: [
          {
            digest: HASH,
            normalizedText: 'select * from leads where id = $1\u001b[2J',
            calls: 10,
            totalTimeMs: 12.5,
            meanTimeMs: 1.25,
            rows: 10,
            sharedBlocksHit: 5,
            sharedBlocksRead: 1,
          },
        ],
        truncated: false,
        source: 'live',
        observedAt: T,
      }),
    )
    const out = await cli([
      'diagnose',
      'query-stats',
      TGT,
      '--from',
      T,
      '--order',
      'mean_time',
      '--limit',
      '20',
    ])
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('select * from leads')
    expect(out.stdout).not.toContain('\u001b')
    const q = sent('GET', `/targets/${TGT}/query-stats`).at(-1)?.query
    expect([q?.get('from'), q?.get('order'), q?.get('limit')]).toEqual([T, 'mean_time', '20'])
  })

  it('reads table statistics with an estimate labeled as such', async () => {
    on(
      'GET',
      `/targets/${TGT}/table-stats`,
      ok('getTableStats', {
        targetId: TGT,
        tables: [
          {
            schema: 'public',
            name: 'leads',
            sizeBytes: 8192,
            indexSizeBytes: 16384,
            sequentialScans: 3,
            indexScans: 9,
            liveTuples: 100,
            deadTuples: 2,
            lastVacuumAt: null,
            lastAutovacuumAt: T,
            lastAnalyzeAt: null,
            lastAutoanalyzeAt: null,
            bloatEstimateBytes: null,
            xidAge: 1000,
          },
        ],
        indexes: [],
        truncated: false,
        source: 'live',
        observedAt: T,
        estimateMethod: 'heuristic_page_estimate',
      }),
    )
    const out = await cli(['diagnose', 'table-stats', TGT, '--schema', 'public'])
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('public.leads')
    expect(out.stdout).toContain('heuristic_page_estimate')
    expect(sent('GET', `/targets/${TGT}/table-stats`)[0]?.query.get('schema')).toBe('public')
  })

  it('runs advisors with the categories asked for and lists the rules that did not run', async () => {
    on(
      'POST',
      `/targets/${TGT}/advisor-runs`,
      ok('runAdvisors', {
        targetId: TGT,
        ranAt: T,
        findings: [
          {
            rule: 'rls_disabled',
            category: 'security',
            level: 'critical',
            object: 'table public.leads',
            message: 'Row level security is disabled.',
            remediation: 'Enable RLS through a migration.',
          },
        ],
        skipped: [{ rule: 'disk_usage', reason: 'needs_node' }],
      }),
    )
    expect((await cli(['diagnose', 'advisors', TGT, '--category', 'nonsense'])).code).toBe(
      EXIT.usage,
    )
    const out = await cli(['diagnose', 'advisors', TGT, '--category', 'security,operations'])
    expect(out.code, out.stderr).toBe(0)
    expect(sent('POST', `/targets/${TGT}/advisor-runs`).at(-1)?.body).toEqual({
      categories: ['security', 'operations'],
    })
    expect(out.stdout).toContain('rls_disabled')
    expect(out.stdout).toContain('needs node')
    expect(out.stdout).toContain('Enable RLS through a migration.')
  })

  it('lists findings with kind, code and target, the summary and a cluster’s findings', async () => {
    on('GET', '/findings', ok('listFindings', { items: [], nextCursor: null }))
    const out = await cli([
      'finding',
      'list',
      '--target',
      TGT,
      '--kind',
      'advisor',
      '--code',
      'rls_disabled',
      '--include-resolved',
    ])
    expect(out.code, out.stderr).toBe(0)
    const q = sent('GET', '/findings')[0]?.query
    expect([q?.get('target'), q?.get('kind'), q?.get('code'), q?.get('state')]).toEqual([
      TGT,
      'advisor',
      'rls_disabled',
      'all',
    ])
    on(
      'GET',
      '/findings/summary',
      ok('getFindingSummary', {
        open: 3,
        bySeverity: { critical: 1, warning: 2, info: 0 },
        byKind: [{ kind: 'advisor', count: 3 }],
        topCodes: [{ kind: 'advisor', code: 'rls_disabled', severity: 'critical', count: 1 }],
        source: 'control_store',
        observedAt: T,
      }),
    )
    const summary = await cli(['finding', 'summary'])
    expect(summary.code, summary.stderr).toBe(0)
    expect(summary.stdout).toContain('1 critical, 2 warning, 0 info')
    on(
      'GET',
      `/clusters/${CLS}/findings`,
      ok('listClusterFindings', { items: [], nextCursor: null }),
    )
    const cluster = await cli(['cluster', 'findings', CLS, '--state', 'all'])
    expect(cluster.code, cluster.stderr).toBe(0)
    expect(sent('GET', `/clusters/${CLS}/findings`)[0]?.query.get('state')).toBe('all')
  })
})

describe('session actions', () => {
  it('cancels a query bound to the backend and query start, inline', async () => {
    on(
      'POST',
      `/targets/${TGT}/sessions/4242/cancel`,
      operation('cancelSessionQuery', 'connections.cancel', 'succeeded'),
    )
    expect(
      (await cli(['session', 'cancel', TGT, '0', '--backend-start', T, '--query-start', T])).code,
    ).toBe(EXIT.usage)
    expect(
      (await cli(['session', 'cancel', TGT, '4242', '--backend-start', 'now', '--query-start', T]))
        .code,
    ).toBe(EXIT.usage)
    expect(sent('POST', `/targets/${TGT}/sessions/4242/cancel`)).toHaveLength(0)
    const out = await cli([
      'session',
      'cancel',
      TGT,
      '4242',
      '--backend-start',
      T,
      '--query-start',
      T,
    ])
    expect(out.code, out.stderr).toBe(0)
    expect(sent('POST', `/targets/${TGT}/sessions/4242/cancel`)[0]?.body).toEqual({
      backendStart: T,
      queryStart: T,
    })
  })

  it('plans a termination with the condition that must still hold', async () => {
    on(
      'POST',
      `/targets/${TGT}/sessions/4242/terminate`,
      plan('planSessionTermination', 'connections.terminate'),
    )
    expect(
      (
        await cli([
          'session',
          'terminate',
          TGT,
          '4242',
          '--backend-start',
          T,
          '--condition',
          'idle',
        ])
      ).code,
    ).toBe(EXIT.usage)
    const out = await cli([
      'session',
      'terminate',
      TGT,
      '4242',
      '--backend-start',
      T,
      '--condition',
      'idle_in_transaction',
      '--reason',
      'holding locks',
    ])
    expect(out.code, out.stderr).toBe(0)
    expect(sent('POST', `/targets/${TGT}/sessions/4242/terminate`)[0]?.body).toEqual({
      backendStart: T,
      condition: 'idle_in_transaction',
      reason: 'holding locks',
    })
  })
})

describe('ledger reconcile (TC-007)', () => {
  const NOTE = 'Restored to the backup of Monday, before the second migration.'

  it('plans adopting the target ledger with a note, and applies nothing without --apply', async () => {
    on(
      'POST',
      `/targets/${TGT}/ledger/reconcile-plans`,
      plan('planLedgerReconcile', 'ledger.reconcile'),
    )
    // The note is the person's reason and is required; nothing is sent without it.
    const bare = await cli(['migration', 'ledger', 'reconcile', '--target', TGT])
    expect(bare.code).toBe(EXIT.usage)
    expect(sent('POST', `/targets/${TGT}/ledger/reconcile-plans`)).toEqual([])
    const out = await cli(['migration', 'ledger', 'reconcile', '--target', TGT, '--note', NOTE])
    expect(out.code, out.stderr).toBe(0)
    expect(sent('POST', `/targets/${TGT}/ledger/reconcile-plans`)[0]?.body).toEqual({
      decision: 'adopt_target',
      note: NOTE,
    })
    expect(out.stdout).toContain('ledger.reconcile')
    expect(requests.filter((r) => r.path.endsWith('/apply'))).toEqual([])
  })

  it('shows the server’s refusal when the ledger agrees with the mirror', async () => {
    on(
      'POST',
      `/targets/${TGT}/ledger/reconcile-plans`,
      refusal(422, 'VALIDATION_FAILED', {
        details: {
          errors: [
            {
              path: '/decision',
              code: 'nothing_to_reconcile',
              message: 'The ledger of the target agrees with the mirror.',
            },
          ],
        },
      }),
    )
    const out = await cli(['migration', 'ledger', 'reconcile', '--target', TGT, '--note', NOTE])
    expect(out.code).toBe(EXIT.usage)
    expect(out.stderr).toContain('/decision: The ledger of the target agrees with the mirror.')
  })

  it('is catalogued as a human-only plan with the scope of the action', () => {
    const command = COMMANDS.find((c) => c.path.join(' ') === 'migration ledger reconcile')
    expect(command).toMatchObject({
      effect: 'plan',
      action: 'ledger.reconcile.plan',
      scopes: ['migrations.import'],
    })
  })
})

describe('node plans create their own basis observation (TC-002)', () => {
  const OBSERVED_FRESH = '2026-10-26T11:58:00.000Z'
  const OBSERVED_STALE = '2026-10-26T11:20:00.000Z'
  const INSPECTION_OP = id('op', 9)

  function node(capabilities: readonly string[]) {
    return ok('getNode', {
      id: NOD,
      serverId: id('srv', 10),
      state: 'active',
      agentVersion: '0.7.0',
      protocolMajor: 1,
      lastHeartbeatAt: T,
      clockSkewMs: 0,
      capabilities: capabilities.map((c) => ({
        name: c.split('@')[0],
        major: Number(c.split('@')[1]),
      })),
      clusters: [],
      host: null,
      nodeCertificateExpiresAt: null,
      source: 'agent_reported',
      observedAt: T,
    })
  }
  const observation = (capability: string, observedAt: string) => ({
    capability,
    clusterId: CLS,
    argsHash: HASH,
    operationId: id('op', 11),
    jobId: id('job', 12),
    source: 'agent_reported',
    observedAt,
    result: {},
  })

  /** A node that offers the kinds, with the observations it has, and an inspection that succeeds. */
  function world(
    observations: readonly ReturnType<typeof observation>[] = [],
    inspect: Answer | null = null,
  ) {
    on(
      'GET',
      `/nodes/${NOD}`,
      node([
        'postgres.reload@2',
        'postgres.restart@1',
        'postgres.config.apply@2',
        'postgres.roles.apply@2',
        'postgres.extensions.apply@1',
      ]),
    )
    on('GET', `/nodes/${NOD}/observations`, (req) =>
      ok('listNodeObservations', {
        items: observations.filter((o) => o.capability === req.query.get('capability')),
      }),
    )
    on(
      'POST',
      `/nodes/${NOD}/inspections`,
      inspect ?? operation('inspectNode', 'node.inspect', 'queued'),
    )
    on(
      'GET',
      `/operations/${INSPECTION_OP}`,
      operation('getOperation', 'node.inspect', 'succeeded'),
    )
  }
  const planned = (kind: string) =>
    on('POST', `/nodes/${NOD}/plans`, plan('planNodeOperation', kind))
  const order = () =>
    requests.filter((r) => r.method === 'POST').map((r) => r.path.replace(NOD, 'NOD'))

  it('inspects the config plan with the changes as typed arguments, then plans', async () => {
    world()
    planned('postgres.config.apply')
    const out = await cli([
      'node',
      'postgres',
      'config',
      NOD,
      '--cluster',
      CLS,
      '--set',
      'work_mem=8MB',
      '--reset',
      'max_wal_size',
      '--no-wait',
    ])
    expect(out.code, out.stderr).toBe(0)
    expect(order()).toEqual(['/nodes/NOD/inspections', '/nodes/NOD/plans'])
    expect(sent('POST', `/nodes/${NOD}/inspections`)[0]?.body).toEqual({
      capability: 'postgres.config.plan@2',
      clusterId: CLS,
      args: {
        changes: [
          { name: 'work_mem', value: '8MB' },
          { name: 'max_wal_size', value: null },
        ],
      },
    })
    expect(sent('POST', `/nodes/${NOD}/plans`)[0]?.body).toMatchObject({
      clusterId: CLS,
      change: { kind: 'postgres.config.apply', reload: true },
    })
  })

  it('inspects the roles with an empty list of expected settings', async () => {
    world()
    planned('postgres.roles.apply')
    const file = join(dir, 'roles.json')
    await writeFile(
      file,
      JSON.stringify({
        steps: [
          {
            op: 'grant_membership',
            role: 'reports',
            attributes: null,
            verifier: null,
            member: 'analyst',
            admin: false,
            inherit: true,
            set: true,
            database: null,
            setting: null,
            value: null,
          },
        ],
      }),
    )
    const out = await cli([
      'node',
      'postgres',
      'roles',
      NOD,
      '--cluster',
      CLS,
      '--file',
      file,
      '--no-wait',
    ])
    expect(out.code, out.stderr).toBe(0)
    expect(sent('POST', `/nodes/${NOD}/inspections`)[0]?.body).toEqual({
      capability: 'postgres.roles.inspect@2',
      clusterId: CLS,
      args: { expectSettings: [] },
    })
  })

  it('reuses an observation younger than five minutes where the arguments do not depend on the change', async () => {
    world([observation('postgres.status@1', OBSERVED_FRESH)])
    planned('postgres.reload')
    const reused = await cli(['node', 'postgres', 'reload', NOD, '--cluster', CLS, '--no-wait'])
    expect(reused.code, reused.stderr).toBe(0)
    expect(order()).toEqual(['/nodes/NOD/plans'])
    // An older one is made again.
    requests = []
    world([observation('postgres.status@1', OBSERVED_STALE)])
    const again = await cli(['node', 'postgres', 'reload', NOD, '--cluster', CLS, '--no-wait'])
    expect(again.code, again.stderr).toBe(0)
    expect(order()).toEqual(['/nodes/NOD/inspections', '/nodes/NOD/plans'])
    expect(sent('POST', `/nodes/${NOD}/inspections`)[0]?.body).toEqual({
      capability: 'postgres.status@1',
      clusterId: CLS,
      args: {},
    })
  })

  it('always inspects where the arguments are the change, however fresh the last one is', async () => {
    world([observation('postgres.config.plan@2', OBSERVED_FRESH)])
    planned('postgres.config.apply')
    await cli([
      'node',
      'postgres',
      'config',
      NOD,
      '--cluster',
      CLS,
      '--set',
      'work_mem=8MB',
      '--no-wait',
    ])
    expect(order()).toEqual(['/nodes/NOD/inspections', '/nodes/NOD/plans'])
  })

  it('skips the inspection with --no-inspect, and plans nothing when the inspection fails', async () => {
    world()
    planned('postgres.config.apply')
    await cli([
      'node',
      'postgres',
      'config',
      NOD,
      '--cluster',
      CLS,
      '--set',
      'work_mem=8MB',
      '--no-inspect',
      '--no-wait',
    ])
    expect(order()).toEqual(['/nodes/NOD/plans'])
    requests = []
    world([], operation('inspectNode', 'node.inspect', 'queued'))
    on('GET', `/operations/${INSPECTION_OP}`, operation('getOperation', 'node.inspect', 'failed'))
    const failed = await cli([
      'node',
      'postgres',
      'config',
      NOD,
      '--cluster',
      CLS,
      '--set',
      'work_mem=8MB',
      '--no-wait',
    ])
    expect(failed.code).not.toBe(0)
    expect(order()).toEqual(['/nodes/NOD/inspections'])
  })

  it('node inspect takes typed arguments with --arg-json, and refuses invalid JSON before sending', async () => {
    world()
    const ok1 = await cli([
      'node',
      'inspect',
      NOD,
      '--capability',
      'postgres.config.plan@2',
      '--cluster',
      CLS,
      '--arg-json',
      'changes=[{"name":"work_mem","value":"8MB"},{"name":"max_wal_size","value":null}]',
      '--arg-json',
      'expectSettings=[]',
      '--arg',
      'note=text',
    ])
    expect(ok1.code, ok1.stderr).toBe(0)
    expect(sent('POST', `/nodes/${NOD}/inspections`)[0]?.body).toMatchObject({
      args: {
        changes: [
          { name: 'work_mem', value: '8MB' },
          { name: 'max_wal_size', value: null },
        ],
        expectSettings: [],
        note: 'text',
      },
    })
    requests = []
    const bad = await cli([
      'node',
      'inspect',
      NOD,
      '--capability',
      'postgres.roles.inspect@2',
      '--arg-json',
      'expectSettings=[oops',
    ])
    expect(bad.code).toBe(EXIT.usage)
    expect(sent('POST', `/nodes/${NOD}/inspections`)).toEqual([])
  })
})

describe('a failed list read (TC-030, principle 5)', () => {
  // Every paged list the CLI has, with the positional arguments it needs.
  const LISTS: readonly (readonly string[])[] = [
    ['product', 'list'],
    ['environment', 'list', id('prd', 10)],
    ['project', 'list'],
    ['target', 'list'],
    ['server', 'list'],
    ['cluster', 'list'],
    ['node', 'list'],
    ['plan', 'list'],
    ['operation', 'list'],
    ['approval', 'list'],
    ['finding', 'list'],
    ['cluster', 'findings', CLS],
    ['schema', 'search', TGT, 'lead'],
    ['backup', 'overview'],
    ['backup', 'list', CLS],
    ['backup', 'runs', CLS],
    ['restore', 'list', CLS],
    ['drill', 'list', CLS],
    ['audit', 'list'],
    ['access', 'identities'],
    ['access', 'bindings'],
    ['access', 'clients'],
  ]

  const NAMED = LISTS.map((argv) => [argv.slice(0, 2).join(' '), argv] as const)

  // Every route answers a missing scope; only the installation read succeeds.
  const denyAll: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    )
    if (url.pathname.replace(/^\/api\/v1/, '') === '/installation') return fakeFetch(input, init)
    const [status, body] = refusal(403, 'INSUFFICIENT_SCOPE', {
      details: { requiredScope: 'backups.read' },
    })
    return Response.json(body, { status })
  }

  it.each(NAMED)(
    '%s: no table, no count and no empty-state text on stdout',
    async (_name, argv) => {
      const out = await cli(argv, { fetch: denyAll })
      expect(out.code).toBe(EXIT.auth)
      expect(out.stdout).toBe('')
      expect(out.stderr).toContain('INSUFFICIENT_SCOPE')
    },
  )

  it.each(NAMED)('%s: the JSON error envelope has no data', async (_name, argv) => {
    const out = await cli([...argv, '--output', 'json'], { fetch: denyAll })
    expect(out.code).toBe(EXIT.auth)
    const doc = JSON.parse(out.stdout)
    expect(doc.status).toBe('error')
    expect(doc.error.code).toBe('INSUFFICIENT_SCOPE')
    expect(doc).not.toHaveProperty('data')
  })

  it('keeps the items that arrived when a later page fails, and says the list is partial', async () => {
    on('GET', `/clusters/${CLS}/backups`, (req) =>
      req.query.get('cursor') === null
        ? catalog([backupEntry(1)], 'c2')
        : refusal(503, 'DEPENDENCY_UNAVAILABLE'),
    )
    const out = await json(['backup', 'list', CLS, '--all'])
    expect(out.code).not.toBe(0)
    expect(out.doc.status).toBe('error')
    expect(out.doc.data.partial).toBe(true)
    expect(out.doc.data.backups).toHaveLength(1)
  })
})

describe('node reads name their server (TC-031)', () => {
  const SRV_A = id('srv', 20)
  const SRV_B = id('srv', 21)
  const SRV_NONE = id('srv', 22)
  const nodeItem = (n: number, serverId: string) => ({
    id: id('nod', n),
    serverId,
    state: 'active',
    agentVersion: '1.0.0',
    protocolMajor: 1,
    lastHeartbeatAt: T,
    clockSkewMs: 0,
    capabilities: [],
  })
  const server = (serverId: string) =>
    ok('getServer', {
      id: serverId,
      displayName: 'db host',
      provider: 'other',
      location: null,
      derivedTier: null,
      observedFacts: null,
      state: 'active',
      retiredAt: null,
    })

  beforeEach(() => {
    on(
      'GET',
      '/nodes',
      ok('listNodes', {
        items: [nodeItem(30, SRV_A), nodeItem(31, SRV_B)],
        nextCursor: null,
      }),
    )
    on('GET', `/servers/${SRV_A}`, server(SRV_A))
    on('GET', `/servers/${SRV_B}`, server(SRV_B))
  })

  it('lists only the nodes of the server it is given', async () => {
    const a = await json(['node', 'list', '--server', SRV_A])
    expect(a.code, a.stderr).toBe(0)
    expect(a.doc.data.items.map((n: { id: string }) => n.id)).toEqual([id('nod', 30)])
    const table = await cli(['node', 'list', '--server', SRV_B])
    expect(table.stdout).toContain(id('nod', 31))
    expect(table.stdout).not.toContain(id('nod', 30))
  })

  it('answers a server that does not exist with NOT_FOUND, not with a list or an empty state', async () => {
    for (const argv of [
      ['node', 'list', '--server', SRV_NONE],
      ['node', 'enrollment', 'status', SRV_NONE],
    ]) {
      const out = await cli(argv)
      expect(out.code, argv.join(' ')).not.toBe(0)
      expect(out.stdout, argv.join(' ')).toBe('')
      expect(out.stderr, argv.join(' ')).toContain('NOT_FOUND')
    }
  })

  it('shows the nodes of a known server that has none as an empty list', async () => {
    on('GET', '/nodes', ok('listNodes', { items: [nodeItem(30, SRV_A)], nextCursor: null }))
    const b = await json(['node', 'list', '--server', SRV_B])
    expect(b.code, b.stderr).toBe(0)
    expect(b.doc.data.items).toEqual([])
  })
})

describe('the import scratch helpers need a scratch target that exists (TC-032)', () => {
  const SCRATCH = 'nope/nope/nope'
  const scratchId = id('tgt', 40)
  const importedId = id('tgt', 41)
  const target = (targetId: string, path: string) =>
    ok('getTarget', {
      id: targetId,
      path,
      productId: id('prd', 1),
      projectId: id('prj', 1),
      environmentId: id('env', 1),
      tier: 'nonprod',
      state: 'active',
      generation: 1,
      health: null,
      environment: { slug: 'scratch', tier: 'nonprod' },
      placement: null,
      ledger: null,
      openFindingCount: 0,
    })
  const notReady = ok('checkScratchTarget', {
    targetId: importedId,
    scratchTargetId: scratchId,
    ready: false,
    checkedAt: T,
    checks: [
      { check: 'scratch_usable', status: 'pass', detail: null, items: [], truncated: false },
      {
        check: 'outside_scope',
        status: 'fail',
        detail: 'objects_missing',
        items: ['auth'],
        truncated: false,
      },
    ],
    copySchemas: ['auth'],
  })

  // The targets route answers per path (a target path is URL-encoded): the scratch is unknown
  // unless a test registers it.
  const routed: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    )
    const path = decodeURIComponent(url.pathname.replace(/^\/api\/v1/, ''))
    if (path === '/installation') return fakeFetch(input, init)
    if (handlers.has(`${init?.method ?? 'GET'} ${path}`)) {
      return fakeFetch(new URL(`${url.origin}/api/v1${path}${url.search}`), init)
    }
    return Response.json(refusal(404, 'TARGET_NOT_FOUND')[1], { status: 404 })
  }

  // What the server really answers for a scratch that does not exist: a check result that
  // names the failure, not an error.
  const unknownScratch = ok('checkScratchTarget', {
    targetId: importedId,
    scratchTargetId: null,
    ready: false,
    checkedAt: T,
    checks: [
      { check: 'scratch_usable', status: 'fail', detail: 'not_found', items: [], truncated: false },
    ],
  })

  it.each([
    ['scratch-check', ['migration', 'import', 'scratch-check']],
    ['scratch-copy-commands', ['migration', 'import', 'scratch-copy-commands']],
  ])(
    '%s: an unknown scratch is TARGET_NOT_FOUND, with no reassurance on stdout',
    async (_n, argv) => {
      on('GET', '/targets/reosa/platform/staging', target(importedId, 'reosa/platform/staging'))
      on('GET', '/targets/reosa/platform/staging/migrations/scratch-check', unknownScratch)
      const out = await cli([...argv, '--target', 'reosa/platform/staging', '--scratch', SCRATCH], {
        fetch: routed,
      })
      expect(out.code).toBe(EXIT.failure)
      expect(out.stderr).toContain('TARGET_NOT_FOUND')
      expect(out.stdout).toBe('')
      expect(out.stdout).not.toContain('nothing to copy')
    },
  )

  it('scratch-check exits non-zero while the scratch is not ready, and keeps the result', async () => {
    on('GET', `/targets/${SCRATCH}`, target(scratchId, SCRATCH))
    on('GET', '/targets/reosa/platform/staging/migrations/scratch-check', notReady)
    const out = await cli(
      [
        'migration',
        'import',
        'scratch-check',
        '--target',
        'reosa/platform/staging',
        '--scratch',
        SCRATCH,
        '--output',
        'json',
      ],
      { fetch: routed },
    )
    expect(out.code).toBe(EXIT.failure)
    const doc = JSON.parse(out.stdout)
    expect(doc.status).toBe('error')
    expect(doc.error.code).toBe('SCRATCH_NOT_READY')
    expect(doc.data).toMatchObject({ ready: false, copySchemas: ['auth'] })
    expect(doc.next).toEqual([expect.stringContaining('scratch-copy-commands')])
  })

  it('scratch-copy-commands stays a success: it is what a scratch that is not ready needs', async () => {
    on('GET', `/targets/${SCRATCH}`, target(scratchId, SCRATCH))
    on('GET', '/targets/reosa/platform/staging', target(importedId, 'reosa/platform/staging'))
    on('GET', '/targets/reosa/platform/staging/migrations/scratch-check', notReady)
    const out = await cli(
      [
        'migration',
        'import',
        'scratch-copy-commands',
        '--target',
        'reosa/platform/staging',
        '--scratch',
        SCRATCH,
      ],
      { fetch: routed },
    )
    expect(out.code, out.stderr).toBe(0)
    expect(out.stdout).toContain('pg_dump')
  })
})
