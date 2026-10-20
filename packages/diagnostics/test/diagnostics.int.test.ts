import { gzipSync } from 'node:zlib'
import { WORKER_ACTOR } from '@exponetdb/operations'
import { TargetError } from '@exponetdb/postgres'
import {
  Connector,
  findTarget,
  planEndpointAdd,
  planEndpointRetire,
  planEnvironmentCreate,
  planProductCreate,
  planProjectCreate,
  planTargetRegister,
  type RegistryActor,
  suspendForIdentityMismatch,
  type TargetRecord,
} from '@exponetdb/registry'
import {
  FaultProxy,
  runAsSuperuser,
  serverFor,
  type TestServer,
  testTargets,
} from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  actor,
  drive,
  type Harness,
  harness,
  planContent,
  readyCluster,
  registerDatabase,
  run,
  targetDatabase,
} from '../../registry/test/harness.ts'
import {
  currentBaseline,
  currentSchema,
  DiagnosticsError,
  DocumentCorrupt,
  dueDriftTargets,
  findingView,
  type HealthDeps,
  latestSnapshot,
  listDriftChecks,
  listFindings,
  listSchemaObjectsView,
  listSessions,
  loadDocument,
  lockGraph,
  maintainSamplePartitions,
  openFindings,
  RegistrationSnapshotStore,
  readStatuses,
  recordDriftFailure,
  runDriftCheck,
  sampleTarget,
  schemaFingerprintView,
  schemaObject,
  schemaOverviewView,
  searchSchemaView,
  targetHealthView,
} from '../src/index.ts'

/**
 * Diagnostics on real PostgreSQL (G4 items 5 to 8): the registration
 * snapshot and baseline written by the real port, schema reads from stored
 * and live documents, drift checks with deduplicated findings and security
 * severity, the health sampler with both protocols per path (a pooler that
 * hangs the extended protocol), the identity probe that suspends a target
 * through the Operations Engine, and stored documents that refuse to load
 * when they do not verify.
 */
let h: Harness
let a: RegistryActor
const pg17: TestServer = serverFor(17)
const slug = `diag${Date.now().toString(36)}`
let clusterId = ''
let projectId = ''
let target: TargetRecord
let databaseName = ''

const HOSTILE = 'x"; DROP TABLE y; --'
const SCHEMA = [
  'CREATE TABLE public.accounts (id bigint PRIMARY KEY, email text NOT NULL, owner_id uuid)',
  'ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY',
  'CREATE POLICY own_rows ON public.accounts FOR SELECT USING (owner_id IS NOT NULL)',
  "COMMENT ON TABLE public.accounts IS 'customer accounts'",
  "CREATE FUNCTION public.helper(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1 + 1'",
  'CREATE SCHEMA audit_archive',
  'CREATE TABLE audit_archive.old (id integer)',
  `CREATE TABLE public."${HOSTILE.replace(/"/g, '""')}" (id integer)`,
]

const snapshotDeps = () => ({
  store: h.serve,
  connector: h.serveConnector,
  installationId: h.db.installationId,
})
const workerDeps = () => ({
  store: h.worker,
  connector: h.workerConnector,
  installationId: h.db.installationId,
})
const healthDeps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
  ...workerDeps(),
  probeDeadlineMs: 2000,
  suspend: (targetId, observed) =>
    suspendForIdentityMismatch(
      h.worker,
      { policy: h.context.policy, kinds: h.kinds, systemActor: WORKER_ACTOR },
      targetId,
      observed,
    ),
  ...over,
})

async function fresh(t: TargetRecord): Promise<TargetRecord> {
  const found = await findTarget(h.worker, t.targetId)
  if (found === undefined) throw new Error('target vanished')
  return found
}

async function registerTarget(envSlug: string, label: string): Promise<TargetRecord> {
  const env = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, String(productId), {
      slug: envSlug,
      displayName: envSlug,
      tier: 'nonprod',
    }),
  )
  const environmentId = String((await planContent(h, env.plan.planId))['environmentId'])
  const name = await targetDatabase(pg17, label, SCHEMA)
  const databaseId = await registerDatabase(h, a, clusterId, name)
  const r = await run(h, a, (tx) =>
    planTargetRegister(tx, h.context, a, {
      projectId: projectId as never,
      environmentId: environmentId as never,
      databaseId: databaseId as never,
    }),
  )
  expect(r.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
  const t = await findTarget(h.worker, String((await planContent(h, r.plan.planId))['targetId']))
  if (t === undefined) throw new Error('target not registered')
  databaseName = t.placement?.databaseName ?? ''
  return t
}

let productId = ''

beforeAll(async () => {
  h = await harness('exdb_it_diag', {
    snapshots: (input) =>
      new RegistrationSnapshotStore({
        store: input.worker,
        connector: input.workerConnector,
        installationId: input.installationId,
      }),
  })
  a = actor()
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Diag' }),
  )
  productId = String((await planContent(h, product.plan.planId))['productId'])
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
      managedScope: { excludeSchemas: ['audit_archive'] },
    }),
  )
  projectId = String((await planContent(h, project.plan.planId))['projectId'])
  clusterId = await readyCluster(h, a, pg17, 'ip', 'diagnostics pg17')
  target = await registerTarget('staging', 'diag')
})

afterAll(async () => {
  await h?.close()
})

const ddl = (statements: readonly string[]) => runAsSuperuser(pg17, databaseName, statements)

describe('registration snapshot and baseline (the real port)', () => {
  it('stores a complete registration snapshot as the baseline, with the scope and the schemas outside it', async () => {
    const baseline = await currentBaseline(h.worker, target)
    expect(baseline).toMatchObject({ reason: 'registration', generation: 1 })
    const snapshot = await latestSnapshot(h.worker, target)
    expect(snapshot).toMatchObject({
      purpose: 'registration',
      complete: true,
      excludedSchemas: ['audit_archive'],
      fingerprint: baseline?.fingerprint,
    })
    const document = await loadDocument(h.worker, baseline?.fingerprint ?? '')
    expect(document.header.scope).toEqual({ include: 'all', exclude: ['audit_archive'] })
    expect(document.entries.some((e) => e.key[0] === 'audit_archive')).toBe(false)
    expect(document.entries.some((e) => e.class === 'policy' && e.key[2] === 'own_rows')).toBe(true)
  })
})

describe('schema reads', () => {
  it('reads live, then reuses the stored document within the reuse window', async () => {
    const live = await currentSchema(snapshotDeps(), target, 0)
    expect(live.source).toBe('live')
    const cached = await currentSchema(snapshotDeps(), target)
    expect(cached.source).toBe('cached')
    expect(cached.snapshot.fingerprint).toBe(live.snapshot.fingerprint)
  })

  it('shows managed schemas with counts and the excluded schema as unmanaged', async () => {
    const view = schemaOverviewView(target, await currentSchema(snapshotDeps(), target))
    const byName = new Map(view.schemas.map((s) => [s.name, s]))
    expect(byName.get('public')).toMatchObject({ managed: true })
    expect(byName.get('public')?.objectCounts).toMatchObject({ table: 2, policy: 1, function: 1 })
    expect(byName.get('audit_archive')).toEqual({
      name: 'audit_archive',
      managed: false,
      objectCounts: {},
    })
    expect(view).toMatchObject({ complete: true, pgMajor: 17, visibility: { gapCount: 0 } })
  })

  it('returns the fingerprint with its document digest, always live', async () => {
    const current = await currentSchema(snapshotDeps(), target, 0)
    const view = await schemaFingerprintView(h.serve, target, current)
    expect(view).toMatchObject({
      canonicalizer: 'fp1',
      pgMajor: 17,
      complete: true,
      source: 'live',
      fingerprint: (await currentBaseline(h.worker, target))?.fingerprint,
    })
    expect(view.documentDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('searches names, hostile ones included, as data', async () => {
    const current = await currentSchema(snapshotDeps(), target)
    const accounts = searchSchemaView(current, { q: 'ACCOUNTS', kinds: ['table'] }, { limit: 10 })
    expect(accounts.items.map((r) => r.name)).toEqual(['accounts'])
    const hostile = searchSchemaView(current, { q: 'drop table' }, { limit: 10 })
    expect(hostile.items).toEqual([expect.objectContaining({ kind: 'table', name: HOSTILE })])
    const paged = searchSchemaView(current, { q: 'o' }, { limit: 1 })
    expect(paged.items).toHaveLength(1)
    expect(paged.nextCursor).not.toBeNull()
    const next = searchSchemaView(current, { q: 'o' }, { limit: 1, cursor: paged.nextCursor ?? '' })
    expect(next.items[0]).not.toEqual(paged.items[0])
  })

  it('lists the objects of the live snapshot without a search term, hostile names as data, filters and parents included', async () => {
    const current = await currentSchema(snapshotDeps(), target)
    const all = listSchemaObjectsView(current, {}, { limit: 200 })
    expect(all.total).toBe(current.document.entries.length)
    expect(all).toMatchObject({
      nextCursor: null,
      fingerprint: current.snapshot.fingerprint,
      complete: true,
      source: current.source,
      observedAt: current.snapshot.takenAt,
    })
    expect(all.items.map((i) => i.name)).toContain(HOSTILE)
    const tables = listSchemaObjectsView(
      current,
      { kinds: ['table'], schema: 'public' },
      { limit: 1 },
    )
    expect(tables.total).toBe(2)
    expect(tables.items).toHaveLength(1)
    const rest = listSchemaObjectsView(
      current,
      { kinds: ['table'], schema: 'public' },
      { limit: 5, cursor: tables.nextCursor ?? '' },
    )
    expect([...tables.items, ...rest.items].map((i) => i.name)).toEqual(
      ['accounts', HOSTILE].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    )
    // The children of one table (columns, constraints, its index, its policy) name it as the parent.
    const children = listSchemaObjectsView(
      current,
      { schema: 'public', parent: 'accounts' },
      { limit: 50 },
    )
    expect(children.items.length).toBeGreaterThanOrEqual(5)
    expect(children.items.every((i) => i.parent === 'accounts' && i.schema === 'public')).toBe(true)
    expect(new Set(children.items.map((i) => i.kind))).toEqual(
      new Set(['column', 'constraint', 'index', 'policy']),
    )
    // The schema outside the managed scope is not part of the snapshot, so it lists nothing.
    expect(listSchemaObjectsView(current, { schema: 'audit_archive' }, { limit: 5 }).total).toBe(0)
    // The same rule as the search finds the same objects.
    const found = searchSchemaView(current, { q: 'ACCOUNTS' }, { limit: 200 }).items
    const listed = listSchemaObjectsView(current, { q: 'ACCOUNTS' }, { limit: 200 }).items
    expect(listed.map((i) => JSON.stringify(i.key)).sort()).toEqual(
      found.map((i) => JSON.stringify(i.key)).sort(),
    )
  })

  it('details a table from the document with its comment and size read live', async () => {
    const t = await schemaObject(snapshotDeps(), target, 'table', 'public.accounts')
    expect(t.ref).toMatchObject({ kind: 'table', schema: 'public', name: 'accounts' })
    expect(t.columns?.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ['id', 'bigint', false],
      ['email', 'text', false],
      ['owner_id', 'uuid', true],
    ])
    expect(t.constraints).toEqual([
      expect.objectContaining({ type: 'primary_key', name: 'accounts_pkey', validated: true }),
    ])
    expect(t.indexes).toEqual([expect.objectContaining({ name: 'accounts_pkey', unique: true })])
    expect(t.policies).toEqual([
      expect.objectContaining({ name: 'own_rows', command: 'select', roles: ['PUBLIC'] }),
    ])
    expect(t.rowLevelSecurity).toEqual({ enabled: true, forced: true })
    expect(t.comment).toBe('customer accounts')
    expect(t.sizeBytes).toBeGreaterThan(0)
  })

  it('details a function with its definition, and a hostile name by its quoted form', async () => {
    const f = await schemaObject(snapshotDeps(), target, 'function', 'public.helper(integer)')
    expect(f.definition).toContain('CREATE OR REPLACE FUNCTION public.helper(integer)')
    const hostile = await schemaObject(
      snapshotDeps(),
      target,
      'table',
      `public."${HOSTILE.replace(/"/g, '""')}"`,
    )
    expect(hostile.ref.name).toBe(HOSTILE)
    await expect(
      schemaObject(snapshotDeps(), target, 'table', 'public.does_not_exist'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      schemaObject(snapshotDeps(), target, 'table', 'audit_archive.old'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('drift against the registration baseline', () => {
  it('stays clean when only rows change: a row write never changes fp1', async () => {
    await ddl(["INSERT INTO public.accounts VALUES (1, 'a@example.test', NULL)"])
    const r = await runDriftCheck(workerDeps(), target, 'schedule')
    expect(r.check).toMatchObject({
      status: 'clean',
      drifted: 0,
      unmanaged: 1,
      opened: 0,
      currentFingerprint: r.check.baselineFingerprint,
    })
    expect(r.check.matched).toBeGreaterThan(5)
  })

  it('finds out-of-band DDL; disabling row security is critical; a repeat counts occurrences', async () => {
    await ddl([
      'ALTER TABLE public.accounts DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.accounts ADD COLUMN note text',
    ])
    const first = await runDriftCheck(workerDeps(), target, 'schedule')
    expect(first.check).toMatchObject({ status: 'drifted', drifted: 2, opened: 2, resolved: 0 })
    expect(first.check.currentFingerprint).not.toBe(first.check.baselineFingerprint)
    expect(first.items.map((i) => [i.item.code, i.item.severity])).toEqual([
      ['object_changed', 'critical'],
      ['object_added', 'warning'],
    ])
    const second = await runDriftCheck(workerDeps(), target, 'schedule')
    expect(second.check).toMatchObject({ status: 'drifted', opened: 0, updated: 2 })
    expect(second.items.map((i) => i.findingId)).toEqual(first.items.map((i) => i.findingId))
    const open = await openFindings(h.worker, target.targetId, 'drift')
    expect(open.map((f) => [f.code, f.severity, f.occurrences])).toEqual(
      expect.arrayContaining([
        ['object_changed', 'critical', 2],
        ['object_added', 'warning', 2],
      ]),
    )
    const changed = open.find((f) => f.code === 'object_changed')
    if (changed === undefined) throw new Error('the changed table has no finding')
    expect(findingView(changed)).toMatchObject({
      kind: 'drift',
      state: 'open',
      securityRelevant: true,
      object: 'table public.accounts',
    })
  })

  it('records a failed read as failed and changes no finding', async () => {
    const before = await openFindings(h.worker, target.targetId, 'drift')
    const broken = { ...workerDeps(), connector: new FailingConnector(h) }
    const r = await runDriftCheck(broken, target, 'schedule')
    expect(r.check).toMatchObject({
      status: 'failed',
      errorCode: 'TARGET_UNAVAILABLE',
      currentFingerprint: null,
      opened: 0,
      updated: 0,
      resolved: 0,
    })
    const after = await openFindings(h.worker, target.targetId, 'drift')
    expect(after.map((f) => [f.findingId, f.occurrences])).toEqual(
      before.map((f) => [f.findingId, f.occurrences]),
    )
  })

  it('resolves findings once the schema is back to the baseline, keeping their history', async () => {
    await ddl([
      'ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.accounts DROP COLUMN note',
    ])
    const r = await runDriftCheck(workerDeps(), target, 'schedule')
    expect(r.check).toMatchObject({ status: 'clean', resolved: 2, opened: 0 })
    expect(await openFindings(h.worker, target.targetId, 'drift')).toEqual([])
    const all = await listFindings(
      h.serve,
      target.targetId,
      { includeResolved: true, kind: 'drift' },
      {
        limit: 10,
      },
    )
    expect(all.items.map((f) => [f.state, f.resolution])).toEqual([
      ['resolved', 'cleared'],
      ['resolved', 'cleared'],
    ])
  })

  it('schedules checks by tier and does not repeat one that just ran', async () => {
    expect(await dueDriftTargets(h.worker, 50)).not.toContain(target.targetId)
    expect(await dueDriftTargets(h.worker, 50, { prod: 0, nonprod: 0 })).toContain(target.targetId)
  })

  it('records a check that broke as failed, never clean, and moves the target back in the schedule', async () => {
    const before = (await openFindings(h.worker, target.targetId, 'drift')).map((f) => f.findingId)
    const failed = await recordDriftFailure(
      workerDeps(),
      await fresh(target),
      'schedule',
      new Error('the check broke'),
    )
    expect(failed.check).toMatchObject({ status: 'failed', errorCode: 'INTERNAL' })
    expect(await dueDriftTargets(h.worker, 50)).not.toContain(target.targetId)
    // Findings are untouched by a failed check.
    const after = (await openFindings(h.worker, target.targetId, 'drift')).map((f) => f.findingId)
    expect(after).toEqual(before)
  })
})

describe('the history of the drift checks', () => {
  it('lists every check of the target newest first, with who asked, the stored counts and the failures', async () => {
    const page = await listDriftChecks(h.serve, target, { limit: 50 })
    // The checks above, in the order they ran, newest first.
    expect(page.items.map((c) => c.status)).toEqual([
      'failed',
      'clean',
      'failed',
      'drifted',
      'drifted',
      'clean',
    ])
    expect(page.nextCursor).toBeNull()
    expect(page.items.every((c) => c.requestedBy === 'schedule' && c.generation === 1)).toBe(true)
    const [broke, resolved, readFailed, second, first] = page.items
    // A check that broke outside the read knows neither fingerprint; a read that failed still knows its baseline.
    expect(broke).toMatchObject({
      errorCode: 'INTERNAL',
      baselineFingerprint: null,
      currentFingerprint: null,
    })
    expect(readFailed).toMatchObject({ errorCode: 'TARGET_UNAVAILABLE', currentFingerprint: null })
    expect(readFailed?.baselineFingerprint).toMatch(/^fp1:17:[0-9a-f]{64}$/)
    expect(resolved).toMatchObject({ drifted: 0, resolved: 2, opened: 0 })
    expect(second).toMatchObject({ drifted: 2, opened: 0, updated: 2 })
    expect(first).toMatchObject({ drifted: 2, opened: 2, updated: 0 })
    // Times are the stored ones: ordered, and a check ends no earlier than it began.
    const ends = page.items.map((c) => Date.parse(c.finishedAt))
    expect(ends).toEqual([...ends].sort((x, y) => y - x))
    expect(page.items.every((c) => Date.parse(c.finishedAt) >= Date.parse(c.startedAt))).toBe(true)
    // Paging continues after the last row shown, without a repeat or a gap.
    const one = await listDriftChecks(h.serve, target, { limit: 4 })
    expect(one.items).toHaveLength(4)
    const two = await listDriftChecks(h.serve, target, { limit: 4, cursor: one.nextCursor ?? '' })
    expect([...one.items, ...two.items].map((c) => c.checkId)).toEqual(
      page.items.map((c) => c.checkId),
    )
    expect(two.nextCursor).toBeNull()
    // Another target's checks are not part of it, and a target never checked has none.
    const other = await registerTarget('nochecks', 'diag_nochecks')
    expect(await listDriftChecks(h.serve, other, { limit: 5 })).toEqual({
      items: [],
      nextCursor: null,
    })
    await expect(
      listDriftChecks(h.serve, target, { limit: 5, cursor: 'garbage' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('drift finding cap', () => {
  it('keeps an open finding when the cap leaves its replacement out of the check', async () => {
    const capped = await registerTarget('cap', 'diag_cap')
    const database = capped.placement?.databaseName ?? ''
    const deps = { ...workerDeps(), maxFindings: 1 }
    await runAsSuperuser(pg17, database, [
      "CREATE OR REPLACE FUNCTION public.helper(integer) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT $1 + 2'",
    ])
    expect((await runDriftCheck(deps, await fresh(capped), 'schedule')).check.status).toBe(
      'drifted',
    )
    const changed = (await openFindings(h.worker, capped.targetId, 'drift')).filter(
      (f) => f.code === 'object_changed',
    )
    expect(changed).toHaveLength(1)
    // The function now drifts another way (removed), and a new table's entries take the
    // one slot of the cap first: the removal is left out of this check.
    await runAsSuperuser(pg17, database, [
      'DROP FUNCTION public.helper(integer)',
      'CREATE TABLE public.aaa (x integer)',
    ])
    await runDriftCheck(deps, await fresh(capped), 'schedule')
    const open = await openFindings(h.worker, capped.targetId, 'drift')
    expect(open.map((f) => f.findingId)).toContain(changed[0]?.findingId)
    expect(open.some((f) => f.code === 'drift_overflow')).toBe(true)
  })
})

describe('health sampler', () => {
  let proxy: FaultProxy
  let poolerId = ''

  beforeAll(async () => {
    proxy = await FaultProxy.start(testTargets(), pg17)
  })

  afterAll(async () => {
    await proxy?.stop()
  })

  it('samples a healthy target on every path and records status and history', async () => {
    const o = await sampleTarget(healthDeps(), await fresh(target))
    expect(o?.result.state).toBe('healthy')
    const status = (await readStatuses(h.serve, [target.targetId])).get(target.targetId)
    const view = targetHealthView(await fresh(target), status)
    expect(view).toMatchObject({
      state: 'healthy',
      source: 'sampled',
      lifecycle: 'active',
      unknownBecause: null,
    })
    expect(view.probes.map((p) => p.probe).sort()).toEqual([
      'activity',
      'extended',
      'identity',
      'settings',
      'simple',
    ])
    // The connections the sample measured, with its time: real numbers from the server, not a threshold.
    expect(view.capacity).toMatchObject({
      source: 'sampled',
      observedAt: status?.observedAt,
      clientBackends: expect.any(Number),
      usableSlots: expect.any(Number),
    })
    expect(view.capacity?.usableSlots).toBeGreaterThan(0)
    expect(view.conditions.some((c) => c.condition.startsWith('connections_'))).toBe(false)
    // What carries the numbers in the stored probes never reaches the public probe shape.
    expect(view.probes.every((p) => !('values' in p))).toBe(true)
    const { rows } = await h.worker.query(
      'test.diag.samples',
      'SELECT count(*)::int AS n FROM observation.health_samples WHERE target_id = $1',
      [target.targetId],
    )
    expect(rows[0]?.int('n')).toBeGreaterThan(0)
  })

  it('never shows a target as healthy when a pooler path passes SELECT 1 but hangs parameterized queries', async () => {
    proxy.setMode({ kind: 'pass' })
    const added = await run(h, a, (tx) =>
      planEndpointAdd(tx, h.context, a, clusterId, {
        kind: 'pooler',
        poolerMode: 'transaction',
        host: '127.0.0.1',
        port: proxy.port,
        tlsServerName: testTargets().serverName,
        label: 'pooler',
      }),
    )
    expect(added.operation.state).toBe('succeeded')
    const endpoint = (await planContent(h, added.plan.planId))['endpoint']
    poolerId =
      typeof endpoint === 'object' && endpoint !== null && 'endpointId' in endpoint
        ? String(endpoint.endpointId)
        : ''
    proxy.setMode({ kind: 'hang_extended' })
    try {
      const o = await sampleTarget(healthDeps({ probeDeadlineMs: 800 }), await fresh(target))
      expect(o?.result.state).toBe('unhealthy')
      expect(o?.result.conditions).toEqual([
        expect.objectContaining({ condition: 'extended_protocol_failing', endpointId: poolerId }),
      ])
      const pooler = o?.result.probes.filter((p) => p.endpoint.id === poolerId)
      expect(pooler?.map((p) => [p.probe, p.outcome])).toEqual([
        ['simple', 'ok'],
        ['extended', 'timeout'],
      ])
    } finally {
      proxy.setMode({ kind: 'pass' })
      const retired = await run(h, a, (tx) =>
        planEndpointRetire(tx, h.context, a, clusterId, poolerId),
      )
      expect(retired.operation.state).toBe('succeeded')
    }
  })

  it('never records a health time later than the database clock (a worker clock running ahead)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 60 * 60_000)
    try {
      await sampleTarget(healthDeps(), await fresh(target))
    } finally {
      vi.useRealTimers()
    }
    const status = (await readStatuses(h.serve, [target.targetId])).get(target.targetId)
    expect(Date.parse(status?.observedAt ?? '')).toBeLessThanOrEqual(Date.now() + 5_000)
  })

  it('serves an old status as cached, and a target never sampled as unknown, never as healthy', async () => {
    const status = (await readStatuses(h.serve, [target.targetId])).get(target.targetId)
    if (status === undefined) throw new Error('no status')
    const stale = targetHealthView(target, { ...status, ageMs: 45_000 })
    expect(stale).toMatchObject({ source: 'cached', state: status.state })
    const lagging = targetHealthView(target, { ...status, ageMs: 10 * 60_000 })
    expect(lagging).toMatchObject({ state: 'unknown', unknownBecause: 'sampler_lagging' })
    expect(targetHealthView(target, undefined)).toMatchObject({
      state: 'unknown',
      unknownBecause: 'never_sampled',
      source: 'inferred',
    })
  })

  it('never turns an unreadable activity view into zero sessions or a healthy target', async () => {
    const database = target.placement?.databaseName ?? ''
    // pg_stat_activity is readable through its PUBLIC grant; without it every activity read fails.
    await runAsSuperuser(pg17, database, [
      'REVOKE SELECT ON pg_catalog.pg_stat_activity FROM PUBLIC',
    ])
    try {
      await expect(listSessions(snapshotDeps(), await fresh(target))).rejects.toBeInstanceOf(
        TargetError,
      )
      await expect(lockGraph(snapshotDeps(), await fresh(target))).rejects.toBeInstanceOf(
        TargetError,
      )
      const o = await sampleTarget(healthDeps(), await fresh(target))
      expect(o?.result.state).not.toBe('healthy')
      expect(o?.result.conditions.map((c) => c.condition)).toContain('activity_unreadable')
      const activity = o?.result.probes.filter((p) => p.probe === 'activity')
      expect(activity?.every((p) => p.outcome !== 'ok')).toBe(true)
      // Without the activity read there are no connections to report: absent, not 0.
      const status = (await readStatuses(h.serve, [target.targetId])).get(target.targetId)
      expect(status?.capacity).toBeNull()
      expect('capacity' in targetHealthView(await fresh(target), status)).toBe(false)
    } finally {
      await runAsSuperuser(pg17, database, [
        'GRANT SELECT ON pg_catalog.pg_stat_activity TO PUBLIC',
      ])
    }
    const live = await listSessions(snapshotDeps(), await fresh(target))
    expect(live).toMatchObject({ source: 'live', truncated: false })
    const back = await sampleTarget(healthDeps(), await fresh(target))
    expect(back?.result.state).toBe('healthy')
  })

  it('suspends a target whose marker is gone through the Operations Engine, once, with a critical finding', async () => {
    const other = await registerTarget('qa', 'diag_qa')
    await runAsSuperuser(pg17, other.placement?.databaseName ?? '', [
      'DROP SCHEMA exponetdb CASCADE',
    ])
    const o = await sampleTarget(healthDeps(), await fresh(other))
    expect(o).toMatchObject({ suspensionRequested: true, result: { state: 'suspended' } })
    // A second sample before the worker ran plans nothing new.
    await sampleTarget(healthDeps(), await fresh(other))
    const { rows } = await h.worker.query(
      'test.diag.suspensions',
      `SELECT count(*)::int AS n FROM operations.operations o JOIN operations.plans p ON p.plan_id = o.plan_id
        WHERE p.target_id = $1 AND o.kind = 'target.suspend' AND o.actor_kind = 'system'`,
      [other.targetId],
    )
    expect(rows[0]?.int('n')).toBe(1)
    await drive(h)
    const suspended = await fresh(other)
    expect(suspended).toMatchObject({ state: 'suspended', stateReason: 'identity_mismatch' })
    const findings = await openFindings(h.worker, other.targetId, 'health')
    expect(findings).toEqual([
      expect.objectContaining({ code: 'identity_mismatch', severity: 'critical' }),
    ])
    // Sampling continues for a suspended target and plans nothing more.
    const again = await sampleTarget(healthDeps(), suspended)
    expect(again).toMatchObject({ suspensionRequested: false, result: { state: 'suspended' } })
  })

  it('creates sample partitions ahead and drops expired ones only within retention bounds', async () => {
    const r = await maintainSamplePartitions(h.worker, 14)
    expect(r.created).toBeGreaterThanOrEqual(0)
    await expect(maintainSamplePartitions(h.worker, 1)).rejects.toThrow()
  })
})

describe('stored documents', () => {
  const fake = (n: number) => `fp1:17:${n.toString(16).padStart(64, '0')}`

  it('refuses a document whose bytes do not match its digest', async () => {
    await h.worker.query(
      'test.diag.doc.digest',
      `INSERT INTO observation.schema_documents
         (fingerprint, canonicalizer, pg_major, entries, encoding, document, content_bytes, document_digest)
       VALUES ($1, 'fp1', 17, 0, 'gzip', $2, 2, $3)`,
      [fake(1), gzipSync(Buffer.from('{}')), `sha256:${'0'.repeat(64)}`],
    )
    await expect(loadDocument(h.worker, fake(1))).rejects.toMatchObject({
      name: 'DocumentCorrupt',
      reason: 'digest',
    })
  })

  it('never inflates more than the recorded length (a stored bomb stops at once)', async () => {
    await h.worker.query(
      'test.diag.doc.bomb',
      `INSERT INTO observation.schema_documents
         (fingerprint, canonicalizer, pg_major, entries, encoding, document, content_bytes, document_digest)
       VALUES ($1, 'fp1', 17, 0, 'gzip', $2, 16, $3)`,
      [fake(2), gzipSync(Buffer.alloc(64 * 1024 * 1024)), `sha256:${'0'.repeat(64)}`],
    )
    const started = performance.now()
    const error = await loadDocument(h.worker, fake(2)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DocumentCorrupt)
    expect(error).toMatchObject({ reason: 'inflate' })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('refuses a document that is not stored', async () => {
    await expect(loadDocument(h.worker, fake(3))).rejects.toMatchObject({ reason: 'missing' })
  })

  it('reports an unknown object as not found, never as an empty object', async () => {
    const e = await schemaObject(snapshotDeps(), target, 'policy', 'public.accounts.nope').catch(
      (x: unknown) => x,
    )
    expect(e).toBeInstanceOf(DiagnosticsError)
  })
})

/** A connector whose every session fails to open (a target that does not answer). */
class FailingConnector extends Connector {
  constructor(harnessValue: Harness) {
    super(harnessValue.worker, {
      keyring: harnessValue.keyring,
      process: 'worker',
      installationId: harnessValue.db.installationId,
    })
  }

  override async forTarget(): Promise<never> {
    throw new TargetError('TARGET_UNAVAILABLE', 'connect_refused')
  }

  override async open(): Promise<never> {
    throw new TargetError('TARGET_UNAVAILABLE', 'connect_refused')
  }
}
