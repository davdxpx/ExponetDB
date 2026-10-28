import { newId, systemClock } from '@exponetdb/kernel'
import {
  KindRegistry,
  processNextOperation,
  readOperation,
  WORKER_ACTOR,
} from '@exponetdb/operations'
import { CONNECTION_RULES, REGISTRY_RULES, RuleRegistry } from '@exponetdb/policy'
import { STALLED_SECONDS, sql, stalledSession } from '@exponetdb/postgres'
import {
  applyRegistryPlan,
  findTarget,
  planEnvironmentCreate,
  planProductCreate,
  planProjectCreate,
  planTargetRegister,
  type RegistryActor,
  type RegistryPolicyContext,
  type TargetRecord,
} from '@exponetdb/registry'
import {
  loginClient,
  runAsSuperuser,
  serverFor,
  type TestServer,
  testRolePassword,
  withSuperuser,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actor,
  type Harness,
  harness,
  planContent,
  readyCluster,
  registerDatabase,
  run,
  submit,
  targetDatabase,
  verifyCredentials,
} from '../../registry/test/harness.ts'
import {
  connectionKinds,
  DiagnosticsError,
  findingSummary,
  listFindings,
  listFleetFindings,
  planCancel,
  planTerminate,
  queryStats,
  RegistrationSnapshotStore,
  readTableStats,
  rollupStatements,
  runAdvisors,
  sampleStatements,
  signalSession,
  tableStats,
} from '../src/index.ts'

/**
 * The diagnostics of Wave 9 Part B on real PostgreSQL 16, 17 and 18
 * (performance.md): statement samples with a reset in between (no negative
 * delta, a reset event, utility statements with passwords stored as a
 * summary), a database without `pg_stat_statements`, table statistics with
 * duplicate indexes, the advisor catalog opening and clearing findings, the
 * findings list across both tables, and cancel and terminate through the
 * Operations Engine (operator session; pid reuse, protected sessions).
 */
let h: Harness
let a: RegistryActor
const slug = `perf${Date.now().toString(36)}`
let productId = ''
let projectId = ''
const clusters = new Map<number, string>()
let policy: RegistryPolicyContext

const SCHEMA = [
  'CREATE EXTENSION IF NOT EXISTS pg_stat_statements',
  'CREATE SCHEMA perf',
  'CREATE TABLE perf.items (id bigint PRIMARY KEY, owner_id bigint, label text)',
  'INSERT INTO perf.items SELECT g, g % 10, md5(g::text) FROM generate_series(1, 500) g',
  'CREATE TABLE perf.owners (id bigint PRIMARY KEY)',
  'INSERT INTO perf.owners SELECT g FROM generate_series(0, 9) g',
  'ALTER TABLE perf.items ADD CONSTRAINT items_owner_fkey FOREIGN KEY (owner_id) REFERENCES perf.owners (id)',
  'CREATE INDEX items_label_a ON perf.items (label)',
  'CREATE INDEX items_label_b ON perf.items (label)',
  'CREATE TABLE perf.log (at timestamptz, line text)',
  'CREATE TABLE perf.secrets (id int PRIMARY KEY)',
  'ALTER TABLE perf.secrets ENABLE ROW LEVEL SECURITY',
  `CREATE FUNCTION perf.definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
]

async function registerTarget(
  server: TestServer,
  label: string,
  extra: readonly string[],
): Promise<TargetRecord> {
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, String(productId), {
      slug: `${label}-${server.major}`,
      displayName: label,
      tier: 'nonprod',
    }),
  )
  const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
  const name = await targetDatabase(server, label, extra)
  const clusterId = clusters.get(server.major) ?? ''
  const databaseId = await registerDatabase(h, a, clusterId, name)
  const r = await run(h, a, (tx) =>
    planTargetRegister(tx, h.context, a, {
      projectId: projectId as never,
      environmentId: environmentId as never,
      databaseId: databaseId as never,
    }),
  )
  expect(r.operation).toMatchObject({ state: 'succeeded' })
  const t = await findTarget(h.worker, String((await planContent(h, r.plan.planId))['targetId']))
  if (t === undefined) throw new Error('target not registered')
  return t
}

const serveDeps = () => ({
  store: h.serve,
  connector: h.serveConnector,
  installationId: h.db.installationId,
})
const workerDeps = () => ({
  store: h.worker,
  connector: h.workerConnector,
  installationId: h.db.installationId,
})

const databaseOf = (t: TargetRecord) => t.placement?.databaseName ?? ''

async function workload(server: TestServer, t: TargetRecord, times: number): Promise<void> {
  await withSuperuser(server, databaseOf(t), async (c) => {
    for (let i = 0; i < times; i++) {
      await c.query('SELECT count(*) FROM perf.items WHERE owner_id = $1', [i % 10])
    }
  })
}

beforeAll(async () => {
  h = await harness('exdb_it_perf', {
    snapshots: (input) =>
      new RegistrationSnapshotStore({
        store: input.worker,
        connector: input.workerConnector,
        installationId: input.installationId,
      }),
  })
  a = actor()
  policy = {
    registry: new RuleRegistry([...REGISTRY_RULES, ...CONNECTION_RULES]),
    codeVersion: '0.1.0+test',
    clock: systemClock,
  }
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Perf' }),
  )
  productId = String((await planContent(h, product.plan.planId))['productId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, { product: slug, slug: 'app', displayName: 'App' }),
  )
  projectId = String((await planContent(h, project.plan.planId))['projectId'])
  for (const major of [16, 17, 18] as const) {
    const server = serverFor(major)
    const clusterId = await readyCluster(h, a, server, 'ip', `perf pg${major}`)
    clusters.set(major, clusterId)
  }
  // pg16 has no operator credential: nothing can signal there (fail closed).
  for (const major of [17, 18]) await submit(h, a, clusters.get(major) ?? '', 'operator')
  await verifyCredentials(h)
}, 300_000)

afterAll(async () => {
  await h?.close()
})

describe.each([16, 17, 18] as const)('statement statistics on PostgreSQL %i', (major) => {
  const server = serverFor(major)
  let target: TargetRecord
  const role = `perf_pw_${slug}_${major}`

  beforeAll(async () => {
    target = await registerTarget(server, 'stmts', SCHEMA)
    await runAsSuperuser(server, 'postgres', [`CREATE ROLE ${role}`])
  }, 120_000)

  it('samples twice with a reset in between: deltas only across no reset, never negative', async () => {
    const db = databaseOf(target)
    await runAsSuperuser(server, db, [`ALTER ROLE ${role} PASSWORD 'secret-${slug}'`])
    await workload(server, target, 5)
    const first = await sampleStatements(workerDeps(), target)
    expect(first).toMatchObject({ outcome: 'ok', discontinuity: 'first', deltas: 0 })
    expect(first.statements).toBeGreaterThan(0)

    await workload(server, target, 20)
    await runAsSuperuser(server, db, [`ALTER ROLE ${role} PASSWORD 'secret-${slug}'`])
    const second = await sampleStatements(workerDeps(), target)
    expect(second).toMatchObject({ outcome: 'ok', discontinuity: 'none' })
    expect(second.deltas).toBeGreaterThan(0)

    const stats = await queryStats(h.serve, target, {})
    expect(stats).toMatchObject({
      source: 'sampled',
      sampling: { state: 'active', intervalSeconds: 300 },
    })
    const select = stats.statements.find((s) => s.normalizedText.includes('perf.items'))
    expect(select).toMatchObject({ calls: 20, textRedacted: false })
    expect(select?.normalizedText).toContain('owner_id = $1')
    expect(select?.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(select?.regression?.state).toBe('insufficient_data')
    // The password statement is stored as a fixed summary, its secret nowhere.
    const secret = stats.statements.find((s) => s.textRedacted === true)
    expect(secret?.normalizedText).toBe('ALTER ROLE <name> PASSWORD <redacted>')
    const { rows } = await h.worker.query(
      'test.perf.secret',
      `SELECT count(*)::int AS n FROM observation.statement_deltas
        WHERE target_id = $1 AND normalized_text LIKE '%secret-%'`,
      [target.targetId],
    )
    expect(rows[0]?.int('n')).toBe(0)

    await runAsSuperuser(server, db, ['SELECT pg_stat_statements_reset()'])
    await workload(server, target, 3)
    const third = await sampleStatements(workerDeps(), target)
    expect(third).toMatchObject({ outcome: 'ok', discontinuity: 'stats_reset', deltas: 0 })

    await workload(server, target, 7)
    const fourth = await sampleStatements(workerDeps(), target)
    expect(fourth).toMatchObject({ outcome: 'ok', discontinuity: 'none' })
    expect(fourth.deltas).toBeGreaterThan(0)

    const negative = await h.worker.query(
      'test.perf.negative',
      `SELECT count(*)::int AS n FROM observation.statement_deltas
        WHERE target_id = $1 AND (calls < 0 OR total_time_ms < 0 OR rows < 0 OR blks_read < 0)`,
      [target.targetId],
    )
    expect(negative.rows[0]?.int('n')).toBe(0)
    const after = await queryStats(h.serve, target, { order: 'calls', limit: 500 })
    expect(after.statements.find((s) => s.normalizedText.includes('perf.items'))?.calls).toBe(27)
    expect(after.sampling?.resets.map((r) => r.kind)).toEqual(['stats_reset'])
    // The read caps: a window longer than 7 days is refused.
    await expect(
      queryStats(h.serve, target, { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    // The daily rollup writes only finished days: nothing of today.
    await rollupStatements(h.worker, 3)
  }, 120_000)
})

describe('a database without pg_stat_statements', () => {
  it('records extension_missing and answers CAPABILITY_UNAVAILABLE', async () => {
    const server = serverFor(17)
    const target = await registerTarget(server, 'noext', ['CREATE TABLE t (id int)'])
    const sample = await sampleStatements(workerDeps(), target)
    expect(sample).toMatchObject({ outcome: 'extension_missing', statements: 0, deltas: 0 })
    const refused = await queryStats(h.serve, target, {}).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(DiagnosticsError)
    expect(refused).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    // And it says which extension is missing, so the answer is not read as a node or cluster problem.
    expect(refused).toMatchObject({
      details: { reason: 'extension_missing', extension: 'pg_stat_statements' },
    })
  }, 120_000)
})

describe('table statistics, advisors and findings (PostgreSQL 17)', () => {
  const server = serverFor(17)
  let target: TargetRecord

  beforeAll(async () => {
    target = await registerTarget(server, 'advise', SCHEMA)
  }, 120_000)

  it('reads tables and indexes live with duplicates, the stats window and the estimate label', async () => {
    const stats = await tableStats(serveDeps(), target, { schema: 'perf', limit: 10 })
    expect(stats).toMatchObject({ source: 'live', estimateMethod: 'heuristic_page_estimate' })
    expect(stats.statsSince).toMatch(/Z$/)
    const items = stats.tables.find((t) => t.name === 'items')
    expect(items?.liveTuples).toBeGreaterThanOrEqual(0)
    expect(items?.xidAge).toBeGreaterThan(0)
    const a1 = stats.indexes.find((i) => i.name === 'items_label_a')
    const b1 = stats.indexes.find((i) => i.name === 'items_label_b')
    expect(a1?.duplicateOf).toBeNull()
    expect(b1?.duplicateOf).toBe('items_label_a')
    expect(stats.indexes.find((i) => i.name === 'items_pkey')).toMatchObject({
      primary: true,
      unique: true,
      valid: true,
    })
    // The limit cuts tables and says so.
    const one = await tableStats(serveDeps(), target, { schema: 'perf', limit: 1 })
    expect(one.tables).toHaveLength(1)
    expect(one.truncated).toBe(true)
    expect(readTableStats).toBeTypeOf('function')
  })

  it('opens advisor findings, counts them again and clears what was fixed', async () => {
    const first = await runAdvisors(
      serveDeps(),
      target,
      ['security', 'performance', 'operations', 'change_safety'],
      { kind: 'identity', identityId: a.identityId },
    )
    expect(first.catalogVersion).toBe(1)
    expect(first.id).toMatch(/^adv_/)
    const rules = new Set(first.findings.map((f) => f.rule))
    for (const rule of [
      'unindexed_foreign_key',
      'duplicate_index',
      'table_without_primary_key',
      'rls_enabled_without_policy',
      'security_definer_without_search_path',
    ]) {
      expect(rules, rule).toContain(rule)
    }
    expect(first.findings.every((f) => typeof f.findingId === 'string')).toBe(true)
    // The statistics count for less than 7 days on a fresh server window: skipped, never a pass.
    const skipped = first.skipped ?? []
    if (skipped.some((s) => s.rule === 'unused_index')) {
      expect(skipped.find((s) => s.rule === 'unused_index')?.reason).toBe('stats_window_short')
    }
    const noPk = first.findings.find((f) => f.rule === 'table_without_primary_key')
    expect(noPk?.object).toBe('table perf.log')
    expect(first.findings.find((f) => f.rule === 'unindexed_foreign_key')?.draft).toBe(
      'migration_draft',
    )

    await runAsSuperuser(server, databaseOf(target), [
      'ALTER TABLE perf.log ADD COLUMN id bigserial PRIMARY KEY',
    ])
    const second = await runAdvisors(serveDeps(), target, ['performance'], {
      kind: 'identity',
      identityId: a.identityId,
    })
    expect(second.findings.map((f) => f.rule)).not.toContain('table_without_primary_key')
    const { rows } = await h.serve.query(
      'test.perf.findings',
      `SELECT code, state, resolution, occurrences FROM observation.subject_findings
        WHERE target_id = $1 AND kind = 'advisor' ORDER BY code`,
      [target.targetId],
    )
    const byCode = new Map(rows.map((r) => [r.text('code'), r]))
    expect(byCode.get('table_without_primary_key')?.text('resolution')).toBe('cleared')
    expect(byCode.get('duplicate_index')?.int('occurrences')).toBe(2)
    // The security findings were not part of the second run: still open, counted once.
    expect(byCode.get('rls_enabled_without_policy')).toMatchObject({})
    expect(byCode.get('rls_enabled_without_policy')?.text('state')).toBe('open')
    expect(byCode.get('rls_enabled_without_policy')?.int('occurrences')).toBe(1)
    const runs = await h.serve.query(
      'test.perf.runs',
      `SELECT outcome FROM observation.advisor_runs WHERE target_id = $1`,
      [target.targetId],
    )
    expect(runs.rows).toHaveLength(2)
  }, 60_000)

  it("an advisor run's record (its audit) commits with the run and its findings, or none of them does (review F-4)", async () => {
    const count = async () => {
      const { rows } = await h.serve.query(
        'test.perf.atomic',
        `SELECT (SELECT count(*) FROM observation.advisor_runs WHERE target_id = $1)::int AS runs,
                (SELECT coalesce(sum(occurrences), 0) FROM observation.subject_findings
                  WHERE target_id = $1 AND kind = 'advisor')::int AS seen`,
        [target.targetId],
      )
      return { runs: rows[0]?.int('runs'), seen: rows[0]?.int('seen') }
    }
    const before = await count()
    let recorded: string | undefined
    await expect(
      runAdvisors(
        serveDeps(),
        target,
        ['performance'],
        { kind: 'identity', identityId: a.identityId },
        Date.now(),
        {
          record: async (_tx, run) => {
            recorded = run.id
            throw new Error('audit unavailable')
          },
        },
      ),
    ).rejects.toThrow('audit unavailable')
    expect(recorded).toMatch(/^adv_/)
    // Nothing of the run is left: no run row, no finding counted again.
    expect(await count()).toEqual(before)
  }, 60_000)

  it('lists drift, health, advisor and statement findings as one, newest first, by kind and code', async () => {
    const all: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 50; i++) {
      const page = await listFindings(
        h.serve,
        target.targetId,
        { includeResolved: true },
        cursor === undefined ? { limit: 2 } : { limit: 2, cursor },
      )
      all.push(...page.items.map((f) => f.findingId))
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(all.length).toBeGreaterThanOrEqual(5)
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort().reverse()).toEqual(all)
    const visibility = {
      all: true,
      productIds: [],
      projectIds: [],
      environmentIds: [],
      targetIds: [],
    }
    const advisor = await listFleetFindings(
      h.serve,
      visibility,
      { kind: 'advisor', code: 'duplicate_index', targetId: target.targetId },
      { limit: 50 },
    )
    expect(advisor.items.length).toBeGreaterThan(0)
    expect(advisor.items.every((f) => f.kind === 'advisor' && f.code === 'duplicate_index')).toBe(
      true,
    )
    const summary = await findingSummary(h.serve, visibility)
    expect(summary.source).toBe('control_store')
    expect(summary.byKind.find((k) => k.kind === 'advisor')?.count).toBeGreaterThan(0)
    expect(summary.open).toBe(
      summary.bySeverity.critical + summary.bySeverity.warning + summary.bySeverity.info,
    )
  })
})

/** A client session of an ordinary login role (never protected). */
async function appSession(
  server: TestServer,
  database: string,
  role: string,
  applicationName = 'perf-app',
): Promise<Awaited<ReturnType<typeof loginClient>>> {
  const client = await loginClient(server, role, testRolePassword(role), database)
  await client.query(`SET application_name = '${applicationName}'`)
  return client
}

/**
 * A `COPY ... FROM STDIN` the test feeds by hand, row by row, on node-postgres'
 * submittable protocol (no copy-stream dependency): `started` settles on the
 * server's CopyInResponse, `done` when the statement completes.
 */
class SlowCopy {
  readonly started: Promise<void>
  readonly done: Promise<void>
  #connection: { sendCopyFromChunk(b: Buffer): void; endCopyFrom(): void } | undefined
  #start: () => void = () => undefined
  #resolve: () => void = () => undefined
  #reject: (e: unknown) => void = () => undefined
  #error: unknown
  #ended = false

  readonly text: string

  constructor(text: string) {
    this.text = text
    this.started = new Promise((resolve) => {
      this.#start = resolve
    })
    this.done = new Promise((resolve, reject) => {
      this.#resolve = resolve
      this.#reject = reject
    })
  }

  submit(connection: { query(text: string): void }) {
    connection.query(this.text)
  }

  handleCopyInResponse(connection: { sendCopyFromChunk(b: Buffer): void; endCopyFrom(): void }) {
    this.#connection = connection
    this.#start()
  }

  send(chunk: string) {
    if (!this.#ended) this.#connection?.sendCopyFromChunk(Buffer.from(chunk))
  }

  end() {
    if (this.#ended) return
    this.#ended = true
    this.#connection?.endCopyFrom()
  }

  handleError(error: unknown) {
    this.#error = error
    this.#start()
  }

  handleReadyForQuery() {
    if (this.#error === undefined) this.#resolve()
    else this.#reject(this.#error)
  }

  handleCommandComplete() {}
  handleRowDescription() {}
  handleDataRow() {}
  handleEmptyQuery() {}
}

interface Backend {
  readonly pid: number
  readonly backendStart: string
  readonly queryStart: string
}

async function backendOf(server: TestServer, application: string): Promise<Backend> {
  for (let i = 0; i < 50; i++) {
    const found = await withSuperuser(server, 'postgres', async (c) => {
      const r = await c.query(
        `SELECT pid, to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bs,
                to_char(query_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS qs
           FROM pg_stat_activity WHERE application_name = $1 AND state = 'active'`,
        [application],
      )
      return r.rows[0] as { pid: number; bs: string; qs: string } | undefined
    })
    if (found !== undefined) return { pid: found.pid, backendStart: found.bs, queryStart: found.qs }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no active backend named ${application}`)
}

describe.each([17, 18] as const)('cancel and terminate on PostgreSQL %i', (major) => {
  const server = serverFor(major)
  let target: TargetRecord
  const role = `perf_app_${slug}_${major}`
  const serveKinds = () => new KindRegistry(connectionKinds({ ...serveDeps(), clock: systemClock }))
  const workerKinds = () =>
    new KindRegistry(connectionKinds({ ...workerDeps(), clock: systemClock }))
  const context = () => ({ policy, observation: serveDeps() })

  beforeAll(async () => {
    target = await registerTarget(server, 'signal', ['CREATE TABLE t (id int)'])
    await runAsSuperuser(server, 'postgres', [
      `CREATE ROLE ${role} LOGIN PASSWORD '${testRolePassword(role)}'`,
      `GRANT CONNECT ON DATABASE ${databaseOf(target)} TO ${role}`,
    ])
  }, 120_000)

  async function execute(plan: { readonly planId: string }) {
    const accepted = await h.serve.transaction('test.perf.apply', (tx) =>
      applyRegistryPlan(
        tx,
        { policy, kinds: serveKinds(), systemActor: WORKER_ACTOR },
        a,
        plan.planId,
      ),
    )
    if (accepted.status !== 'accepted') return { refused: accepted.error }
    const workerId = newId('prc', Date.now())
    for (let i = 0; i < 10; i++) {
      const r = await processNextOperation(h.worker, {
        workerId,
        kinds: workerKinds(),
        clock: systemClock,
      })
      if (r.status === 'idle') break
    }
    return { operation: await readOperation(h.worker, accepted.operation.operationId) }
  }

  it('cancels the running query it was planned for, and the operation verifies it', async () => {
    const client = await appSession(server, databaseOf(target), role, `perf-cancel-${major}`)
    const sleeping = client.query('SELECT pg_sleep(30)').catch((e: { code?: string }) => e.code)
    try {
      const b = await backendOf(server, `perf-cancel-${major}`)
      const plan = await h.serve.transaction('test.perf.cancel', (tx) =>
        planCancel(tx, context(), a, target.targetId, b),
      )
      expect(plan).toMatchObject({
        kind: 'connections.cancel',
        actionClass: 'low',
        decision: 'allow',
      })
      const done = await execute(plan)
      expect(done.operation).toMatchObject({
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
      })
      expect(await sleeping).toBe('57014')
    } finally {
      await client.end()
    }
  }, 60_000)

  it('signals nothing for a reused pid, another query or a condition that does not hold', async () => {
    const client = await appSession(server, databaseOf(target), role, `perf-stale-${major}`)
    const sleeping = client.query('SELECT pg_sleep(20)').catch(() => undefined)
    const opened = await h.workerConnector.forTarget(target, 'operator', 'test/signal')
    try {
      const b = await backendOf(server, `perf-stale-${major}`)
      const session = opened.session
      // Another backend start at the same pid: a reused pid is never signaled.
      expect(
        await signalSession(session, 'connections.terminate', {
          ...b,
          backendStart: '2000-01-01T00:00:00.000Z',
          condition: 'any',
        }),
      ).toBe('not_matched')
      // Another query start: the cancel acts only while the same query runs.
      expect(
        await signalSession(session, 'connections.cancel', {
          ...b,
          queryStart: '2000-01-01T00:00:00.000Z',
        }),
      ).toBe('not_matched')
      // The query runs for seconds, not 300: long_running does not hold.
      expect(
        await signalSession(session, 'connections.terminate', { ...b, condition: 'long_running' }),
      ).toBe('not_matched')
      expect(
        await signalSession(session, 'connections.terminate', { ...b, condition: 'stalled' }),
      ).toBe('not_matched')
      // A plan bound to a query that no longer runs is stale at apply.
      const plan = await h.serve.transaction('test.perf.cancel_stale', (tx) =>
        planCancel(tx, context(), a, target.targetId, {
          ...b,
          queryStart: '2000-01-01T00:00:00.000Z',
        }),
      )
      const refused = await execute(plan)
      expect(refused.refused).toMatchObject({ code: 'PLAN_STALE' })
    } finally {
      await opened.session.close()
      await client.end()
      await sleeping
    }
  }, 60_000)

  it('terminates a session by plan, the backend is gone and verified', async () => {
    const client = await appSession(server, databaseOf(target), role, `perf-term-${major}`)
    const sleeping = client.query('SELECT pg_sleep(30)').catch((e: { code?: string }) => e.code)
    try {
      const b = await backendOf(server, `perf-term-${major}`)
      const plan = await h.serve.transaction('test.perf.terminate', (tx) =>
        planTerminate(tx, context(), a, target.targetId, {
          pid: b.pid,
          backendStart: b.backendStart,
          condition: 'any',
          reason: 'test',
        }),
      )
      expect(plan).toMatchObject({ kind: 'connections.terminate', actionClass: 'standard' })
      const done = await execute(plan)
      expect(done.operation).toMatchObject({
        state: 'succeeded',
        applyOutcome: 'applied',
        verificationOutcome: 'passed',
      })
      expect(await sleeping).toBe('57P01')
      const audit = await h.worker.query(
        'test.perf.audit',
        `SELECT count(*)::int AS n FROM audit.audit_events WHERE action = 'connections.terminate'`,
      )
      expect(audit.rows[0]?.int('n')).toBeGreaterThanOrEqual(1)
    } finally {
      await client.end().catch(() => undefined)
    }
  }, 60_000)

  it('denies a superuser session and a backup session by policy', async () => {
    const su = await withSuperuser(server, databaseOf(target), async (c) => {
      const r = await c.query(
        `SELECT pg_backend_pid() AS pid,
                to_char(backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bs
           FROM pg_stat_activity WHERE pid = pg_backend_pid()`,
      )
      const row = r.rows[0] as { pid: number; bs: string }
      return h.serve.transaction('test.perf.deny_su', (tx) =>
        planTerminate(tx, context(), a, target.targetId, {
          pid: row.pid,
          backendStart: row.bs,
          condition: 'any',
        }),
      )
    })
    expect(su).toMatchObject({ state: 'denied', decision: 'deny' })
    const client = await appSession(server, databaseOf(target), role, 'pg_dump')
    const sleeping = client.query('SELECT pg_sleep(10)').catch(() => undefined)
    try {
      const b = await backendOf(server, 'pg_dump')
      const dump = await h.serve.transaction('test.perf.deny_dump', (tx) =>
        planCancel(tx, context(), a, target.targetId, b),
      )
      expect(dump).toMatchObject({ state: 'denied', decision: 'deny' })
      const refused = await execute(dump)
      expect(refused.refused).toBeDefined()
    } finally {
      await client.end().catch(() => undefined)
      await sleeping
    }
  }, 60_000)

  it('denies a login that may SET ROLE to a superuser, and a pg_probackup session (review D-4)', async () => {
    const member = `${role}_member`
    const su = `${role}_su`
    await runAsSuperuser(server, 'postgres', [
      `CREATE ROLE ${su} SUPERUSER NOLOGIN`,
      `CREATE ROLE ${member} LOGIN PASSWORD '${testRolePassword(member)}'`,
      `GRANT CONNECT ON DATABASE ${databaseOf(target)} TO ${member}`,
      `GRANT ${su} TO ${member}`,
    ])
    // The login role itself is not a superuser; it could SET ROLE to one.
    const viaRole = await appSession(server, databaseOf(target), member, `perf-setrole-${major}`)
    const sleeping = viaRole.query('SELECT pg_sleep(10)').catch(() => undefined)
    try {
      const b = await backendOf(server, `perf-setrole-${major}`)
      const plan = await h.serve.transaction('test.perf.deny_member', (tx) =>
        planCancel(tx, context(), a, target.targetId, b),
      )
      expect(plan).toMatchObject({ state: 'denied', decision: 'deny' })
    } finally {
      await viaRole.end().catch(() => undefined)
      await sleeping
    }
    const backup = await appSession(server, databaseOf(target), role, 'pg_probackup')
    const backingUp = backup.query('SELECT pg_sleep(10)').catch(() => undefined)
    try {
      const b = await backendOf(server, 'pg_probackup')
      const plan = await h.serve.transaction('test.perf.deny_probackup', (tx) =>
        planCancel(tx, context(), a, target.targetId, b),
      )
      expect(plan).toMatchObject({ state: 'denied', decision: 'deny' })
    } finally {
      await backup.end().catch(() => undefined)
      await backingUp
    }
  }, 60_000)

  it('a COPY FROM that keeps reading rows is never stalled, and a stalled terminate does not match it (review D-1)', async () => {
    await runAsSuperuser(server, databaseOf(target), [`GRANT INSERT ON TABLE t TO ${role}`])
    const application = `perf-copy-${major}`
    const client = await appSession(server, databaseOf(target), role, application)
    const copy = new SlowCopy('COPY t (id) FROM STDIN')
    client.query(copy as never)
    const opened = await h.workerConnector.forTarget(target, 'operator', 'test/copy')
    let feeding: ReturnType<typeof setInterval> | undefined
    try {
      await copy.started
      let row = 0
      // A slow client: one row every two seconds, for longer than the stalled threshold.
      feeding = setInterval(() => copy.send(`${++row}\n`), 2_000)
      const b = await backendOf(server, application)
      await new Promise((r) => setTimeout(r, (STALLED_SECONDS + 5) * 1000))
      // Sampled while it waits on ClientRead (between two rows): the condition without the
      // COPY exclusion holds, the shared predicate does not.
      let seen: { waiting: boolean; old: boolean; stalled: boolean } | undefined
      for (let i = 0; i < 40 && seen?.waiting !== true; i++) {
        seen = await withSuperuser(server, 'postgres', async (c) => {
          const r = await c.query(
            `SELECT a.wait_event = 'ClientRead' AS waiting,
                    (a.state = 'active' AND a.wait_event = 'ClientRead'
                       AND a.query_start <= clock_timestamp() - interval '60 seconds') AS old,
                    ${stalledSession(sql`a`).text} AS stalled
               FROM pg_stat_activity a WHERE a.pid = $1`,
            [b.pid],
          )
          return r.rows[0] as { waiting: boolean; old: boolean; stalled: boolean }
        })
        if (seen?.waiting !== true) await new Promise((r) => setTimeout(r, 50))
      }
      expect(seen).toEqual({ waiting: true, old: true, stalled: false })
      expect(
        await signalSession(opened.session, 'connections.terminate', {
          ...b,
          condition: 'stalled',
        }),
      ).toBe('not_matched')
      const plan = await h.serve.transaction('test.perf.copy_stalled', (tx) =>
        planTerminate(tx, context(), a, target.targetId, {
          pid: b.pid,
          backendStart: b.backendStart,
          condition: 'stalled',
          reason: 'test',
        }),
      )
      const refused = await execute(plan)
      expect(refused.refused).toMatchObject({ code: 'PLAN_STALE' })
    } finally {
      if (feeding !== undefined) clearInterval(feeding)
      copy.end()
      await copy.done.catch(() => undefined)
      await opened.session.close()
      await client.end().catch(() => undefined)
    }
  }, 120_000)
})

describe('a cluster without an operator credential', () => {
  it('refuses to plan a cancel (fail closed: no ExponetDB login may signal)', async () => {
    const target = await registerTarget(serverFor(16), 'nosignal', ['CREATE TABLE t (id int)'])
    const refused = await h.serve
      .transaction('test.perf.no_operator', (tx) =>
        planCancel(tx, { policy, observation: serveDeps() }, a, target.targetId, {
          pid: 1,
          backendStart: '2026-01-01T00:00:00.000Z',
          queryStart: '2026-01-01T00:00:00.000Z',
        }),
      )
      .catch((e: unknown) => e)
    expect(refused).toMatchObject({ code: 'TARGET_CREDENTIAL_INVALID' })
  }, 120_000)
})
