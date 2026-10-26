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
      }),
    )
    const refused = await cli(['diagnose', 'query-stats', TGT])
    expect(refused.code).toBe(EXIT.failure)
    expect(refused.stderr).toContain('CAPABILITY_UNAVAILABLE')
    expect(refused.stderr).toContain('shared_preload_libraries')
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
