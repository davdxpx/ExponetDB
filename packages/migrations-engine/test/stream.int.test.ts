import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { evidenceOrder, projectStream, STREAM_BUNDLE_LIMIT } from '../src/index.ts'

/**
 * The promotion stream of a project from the Control Store mirrors (Wave 8
 * order §9) on real PostgreSQL 17: bundles in dependency order, environments
 * in evidence order, and per bundle and environment what the mirror of the
 * project's target says; a target the mirror has no record of at its current
 * generation reads `unknown`, never `not_applied`.
 */
let db: MigratedTestDatabase
let operationId = ''

const hex = (c: string) => c.repeat(64)
const checksum = (c: string) => `sha256:c1:${hex(c)}`
const ulid = (ms: number) => newId('op', ms).slice(3)

async function sql(text: string, params: unknown[] = []) {
  await db.asSuperuser((c) => c.query(text, params))
}

interface Fixture {
  readonly projectId: string
  readonly productId: string
  readonly targets: { readonly dev: string; readonly staging: string; readonly production: string }
  readonly bundles: {
    readonly a: string
    readonly b: string
    readonly c: string
    readonly d: string
  }
}

async function bundle(
  projectId: string,
  id: string,
  name: string,
  dependsOn: string[],
  sum: string,
  revision = 1,
) {
  await sql(
    `INSERT INTO migrations.bundle_revisions
       (project_id, migration_id, revision, name, checksum, source_digest, bundle_digest, transactional,
        depends_on, manifest, defaults, manifest_yaml, up_sql, ingested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8::text[], '{}', '{}', ''::bytea, ''::bytea, $9)`,
    [
      projectId,
      id,
      revision,
      name,
      checksum(sum),
      `sha256:${hex(sum)}`,
      checksum(sum),
      dependsOn,
      newId('idn', Date.now()),
    ],
  )
}

async function target(
  f: { projectId: string; productId: string },
  slug: string,
  envId: string,
  tier: string,
  productSlug: string,
) {
  const id = newId('tgt', Date.now() + Math.floor(Math.random() * 1000))
  await sql(
    `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                   created_at, created_by_operation_id, state_changed_at, state_changed_by_operation_id)
     VALUES ($1, $2, $3, $4, $5, 1, 'registered', now(), $6, now(), $6)`,
    [id, f.projectId, envId, `${productSlug}/platform/${slug}`, tier, operationId],
  )
  return id
}

async function fixture(label: string): Promise<Fixture> {
  const now = Date.now()
  const productId = newId('prd', now)
  const projectId = newId('prj', now)
  const env = {
    dev: newId('env', now),
    staging: newId('env', now + 1),
    production: newId('env', now + 2),
    preview: newId('env', now + 3),
  }
  const slug = `stream${label}`
  await sql(
    `INSERT INTO registry.products (product_id, slug, display_name, created_at, created_by_operation_id)
     VALUES ($1, $2, 'P', now(), $3)`,
    [productId, slug, operationId],
  )
  // Production takes evidence from staging, which takes it from dev; preview from none. The ranks
  // disagree with that order on purpose: evidence decides, the rank orders what is free.
  const insertEnvironment = (
    id: string,
    slugOf: string,
    tier: string,
    evidenceFrom: string | null,
    rank: number,
  ) =>
    sql(
      `INSERT INTO registry.environments (environment_id, product_id, slug, display_name, tier, evidence_from, rank, created_at, created_by_operation_id)
       VALUES ($1, $2, $3, $3, $4, $5, $6, now(), $7)`,
      [id, productId, slugOf, tier, evidenceFrom, rank, operationId],
    )
  await insertEnvironment(env.dev, 'dev', 'nonprod', null, 2)
  await insertEnvironment(env.staging, 'staging', 'nonprod', env.dev, 1)
  await insertEnvironment(env.production, 'production', 'prod', env.staging, 0)
  await insertEnvironment(env.preview, 'preview', 'nonprod', null, 5)
  await sql(
    `INSERT INTO registry.projects (project_id, product_id, slug, display_name, managed_scope, created_at, created_by_operation_id)
     VALUES ($1, $2, 'platform', 'Platform', '{"excludeSchemas": []}', now(), $3)`,
    [projectId, productId, operationId],
  )
  const base = { projectId, productId }
  const targets = {
    dev: await target(base, 'dev', env.dev, 'nonprod', slug),
    staging: await target(base, 'staging', env.staging, 'nonprod', slug),
    production: await target(base, 'production', env.production, 'prod', slug),
  }
  const bundles = {
    a: ulid(now + 10),
    b: ulid(now + 20),
    c: ulid(now + 30),
    d: ulid(now + 40),
  }
  // d is the smallest id's rival: a ← b ← c, and a ← d (two heads).
  await bundle(projectId, bundles.a, 'create-users', [], 'a')
  await bundle(projectId, bundles.b, 'add-email', [bundles.a], 'b')
  await bundle(projectId, bundles.c, 'add-index', [bundles.b], 'c')
  await bundle(projectId, bundles.d, 'add-teams', [bundles.a], 'd')
  return { ...base, targets, bundles }
}

async function mirror(
  targetId: string,
  rows: { id: string; sum: string; reverted?: boolean }[],
  options: { divergent?: unknown; observed?: string; generation?: number } = {},
) {
  const generation = options.generation ?? 1
  await sql(
    `INSERT INTO migrations.ledger_state (target_id, generation, ledger_state_hash, observed_at, divergent, divergence)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6::jsonb)`,
    [
      targetId,
      generation,
      `sha256:ls1:${hex('e')}`,
      options.observed ?? new Date(Date.now() - 3_600_000).toISOString(),
      options.divergent !== undefined,
      options.divergent === undefined ? null : JSON.stringify(options.divergent),
    ],
  )
  let seq = 0
  for (const r of rows) {
    seq += 1
    await sql(
      `INSERT INTO migrations.ledger_mirror (target_id, generation, migration_id, origin, name, checksum, applied_seq,
                                              applied_at, operation_id, reverted_at)
       VALUES ($1, $2, $3, 'exponetdb', 'n', $4, $5, now() - interval '2 hours', $6,
               CASE WHEN $7::boolean THEN now() - interval '1 hour' END)`,
      [targetId, generation, r.id, checksum(r.sum), seq, operationId, r.reverted === true],
    )
  }
}

async function verification(targetId: string, migrationId: string, status: string, ago: number) {
  await sql(
    `INSERT INTO migrations.verification_mirror (verification_id, target_id, generation, migration_id, operation_id,
        status, started_at, finished_at, structural, engine, fingerprint)
     VALUES ($1, $2, 1, $3, $4, $5, now() - make_interval(mins => $6), now() - make_interval(mins => $6), '{}', '{}', 'fp')`,
    [
      newId('vfy', Date.now() + Math.floor(Math.random() * 100000)),
      targetId,
      migrationId,
      operationId,
      status,
      ago,
    ],
  )
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_migration_stream')
  operationId = newId('op', Date.now())
  await sql(
    `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome, actor_kind, client_kind)
     VALUES ($1, 'registry.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
    [operationId],
  )
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

const all = async () => true

describe('the stream of a project', () => {
  let f: Fixture
  let stream: Awaited<ReturnType<typeof projectStream>>

  beforeAll(async () => {
    f = await fixture('one')
    const { a, b, c } = f.bundles
    // dev: a verified, b applied with a failed verification, c applied and not yet verified, d not applied.
    await mirror(f.targets.dev, [
      { id: a, sum: 'a' },
      { id: b, sum: 'b' },
      { id: c, sum: 'c' },
      // A row the stream has no bundle for (a baseline).
      { id: 'baseline:legacy', sum: 'f' },
    ])
    await verification(f.targets.dev, a, 'failed', 90)
    await verification(f.targets.dev, a, 'passed', 30)
    await verification(f.targets.dev, b, 'partial', 20)
    // staging: a verified, b reverted, and the ledger differs from the mirror at c.
    await mirror(
      f.targets.staging,
      [
        { id: a, sum: 'a' },
        { id: b, sum: 'b', reverted: true },
      ],
      { divergent: { missing: [], checksumDiffers: [c], unrecorded: [] } },
    )
    await verification(f.targets.staging, a, 'passed', 10)
    // production: no mirror at all.
    stream = await projectStream(db.store('exdb_serve'), f.projectId, all)
  })

  it('lists the bundles in dependency order with their dependencies and the heads', () => {
    const { a, b, c, d } = f.bundles
    expect(stream.graph).toEqual({ valid: true, errors: [] })
    // a first; then the smallest ready id: b, c (its dependent) before d? ids ascend a < b < c < d.
    expect(stream.bundles.map((x) => x.migrationId)).toEqual([a, b, c, d])
    expect(stream.bundles.map((x) => x.dependsOn)).toEqual([[], [a], [b], [a]])
    expect(stream.heads).toEqual([c, d])
    expect(stream.bundleCount).toBe(4)
    expect(stream.truncated).toBe(false)
    expect(stream.bundles.map((x) => x.name)).toEqual([
      'create-users',
      'add-email',
      'add-index',
      'add-teams',
    ])
  })

  it('lists the environments in evidence order, with the live target of each', () => {
    expect(stream.environments.map((e) => e.slug)).toEqual([
      'dev',
      'staging',
      'production',
      'preview',
    ])
    expect(stream.environments.map((e) => e.evidenceFrom)).toEqual([null, 'dev', 'staging', null])
    expect(stream.environments.map((e) => e.target?.id ?? null)).toEqual([
      f.targets.dev,
      f.targets.staging,
      f.targets.production,
      null,
    ])
    expect(stream.environments[0]?.target).toMatchObject({ lifecycle: 'registered', generation: 1 })
  })

  const cell = (bundle: string, env: string) =>
    stream.bundles.find((b) => b.migrationId === bundle)?.states.find((s) => s.environment === env)

  it('reads the mirror per bundle and environment, with the time of the mirror', () => {
    const { a, b, c, d } = f.bundles
    // The latest verification decides: a failed one and a later passed one is verified.
    expect(cell(a, 'dev')).toMatchObject({
      state: 'verified',
      checksumMatches: true,
      verification: { status: 'passed' },
    })
    expect(cell(b, 'dev')).toMatchObject({ state: 'failed', verification: { status: 'partial' } })
    expect(cell(c, 'dev')).toMatchObject({ state: 'applied', verification: null })
    expect(cell(d, 'dev')).toMatchObject({ state: 'not_applied', appliedAt: null, checksum: null })
    expect(cell(a, 'staging')?.state).toBe('verified')
    expect(cell(b, 'staging')?.state).toBe('reverted')
    // The ledger of staging differs from the mirror at c: divergent, whatever the mirror holds for it.
    expect(cell(c, 'staging')?.state).toBe('divergent')
    expect(cell(d, 'staging')?.state).toBe('not_applied')
    const dev = stream.environments[0]?.mirror
    expect(dev).toMatchObject({ divergent: false, divergence: null, entriesOutsideStream: 1 })
    expect(stream.environments[1]?.mirror).toMatchObject({
      divergent: true,
      divergence: { checksumDiffers: [c] },
    })
    for (const x of stream.bundles) {
      expect(x.states.find((s) => s.environment === 'dev')?.observedAt).toBe(dev?.observedAt)
    }
  })

  it('reads a target without a mirror as unknown, never as not applied, and has no cell for an environment without a target', () => {
    for (const x of stream.bundles) {
      expect(x.states.map((s) => s.environment)).toEqual(['dev', 'staging', 'production'])
      expect(x.states.find((s) => s.environment === 'production')).toMatchObject({
        state: 'unknown',
        observedAt: null,
        checksum: null,
        verification: null,
      })
    }
    expect(stream.environments[2]?.mirror).toBeNull()
  })

  it('says it is the mirror, not a live read', () => {
    expect(stream.source).toBe('cached')
    expect(Date.parse(stream.observedAt)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('leaves a target the caller may not see out, as an environment without one', async () => {
    const hidden = await projectStream(
      db.store('exdb_serve'),
      f.projectId,
      async (id) => id !== f.targets.staging,
    )
    expect(hidden.environments.map((e) => e.target?.id ?? null)).toEqual([
      f.targets.dev,
      null,
      f.targets.production,
      null,
    ])
    expect(hidden.environments[1]?.mirror).toBeNull()
    for (const x of hidden.bundles) {
      expect(x.states.map((s) => s.environment)).toEqual(['dev', 'production'])
    }
    // Nothing of the hidden target is anywhere in the answer.
    expect(JSON.stringify(hidden)).not.toContain(f.targets.staging)
    const none = await projectStream(db.store('exdb_serve'), f.projectId, async () => false)
    expect(none.bundles.every((x) => x.states.length === 0)).toBe(true)
    expect(none.environments.every((e) => e.target === null && e.mirror === null)).toBe(true)
  })

  it('reads a mirror of an earlier generation as no mirror', async () => {
    const g = await fixture('gen')
    await mirror(g.targets.dev, [{ id: g.bundles.a, sum: 'a' }])
    // The target moved to a new generation (a restore): the old mirror says nothing about it.
    await sql(`UPDATE registry.targets SET generation = 2 WHERE target_id = $1`, [g.targets.dev])
    const read = await projectStream(db.store('exdb_serve'), g.projectId, all)
    expect(read.bundles[0]?.states.find((s) => s.environment === 'dev')?.state).toBe('unknown')
    expect(read.environments[0]?.mirror).toBeNull()
  })
})

describe('a stream that is not a valid graph', () => {
  it('says so and lists the bundles by id, with no heads', async () => {
    const f = await fixture('bad')
    const ghost = ulid(Date.now() + 99_000)
    await bundle(f.projectId, ulid(Date.now() + 50), 'orphan', [ghost], '9')
    const read = await projectStream(db.store('exdb_serve'), f.projectId, all)
    expect(read.graph.valid).toBe(false)
    expect(read.graph.errors[0]).toMatchObject({ code: 'MIGRATION_DEPENDENCY_UNKNOWN' })
    expect(read.graph.errors[0]?.migrationIds).toContain(ghost)
    expect(read.heads).toEqual([])
    const ids = read.bundles.map((b) => b.migrationId)
    expect(ids).toEqual([...ids].sort())
  })

  it('knows a baseline a bundle depends on', async () => {
    const f = await fixture('base')
    await bundle(f.projectId, ulid(Date.now() + 60), 'after-baseline', ['baseline:legacy'], '8')
    // The other bundles are roots: a stream with a baseline anchors its roots at it.
    const read = await projectStream(db.store('exdb_serve'), f.projectId, all)
    expect(read.baselines).toEqual(['baseline:legacy'])
    expect(read.graph.valid).toBe(false)
    expect(read.graph.errors[0]?.code).toBe('MIGRATION_DEPENDENCY_MISSING')
  })
})

describe('a stream larger than the listing', () => {
  it('lists the last bundles in order and says it cut the rest', async () => {
    const f = await fixture('big')
    const ids = Array.from({ length: STREAM_BUNDLE_LIMIT - 3 }, (_, i) =>
      ulid(Date.now() + 1000 + i * 7),
    )
    // Chain them: each depends on the one before; the first on a.
    await db.asSuperuser((c) =>
      c.query(
        `INSERT INTO migrations.bundle_revisions
           (project_id, migration_id, revision, name, checksum, source_digest, bundle_digest, transactional,
            depends_on, manifest, defaults, manifest_yaml, up_sql, ingested_by)
         SELECT $1, id, 1, 'bulk', $3, $4, $3, true, ARRAY[dep], '{}', '{}', ''::bytea, ''::bytea, $5
           FROM unnest($2::text[], $6::text[]) AS t(id, dep)`,
        [
          f.projectId,
          [...ids],
          checksum('7'),
          `sha256:${hex('7')}`,
          newId('idn', Date.now()),
          [f.bundles.a, ...ids.slice(0, -1)],
        ],
      ),
    )
    const read = await projectStream(db.store('exdb_serve'), f.projectId, all)
    expect(read.bundleCount).toBe(STREAM_BUNDLE_LIMIT + 1)
    expect(read.bundles).toHaveLength(STREAM_BUNDLE_LIMIT)
    expect(read.truncated).toBe(true)
    // The last in dependency order are kept: the tail of the chain is listed.
    expect(read.bundles[read.bundles.length - 1]?.migrationId).toBe(ids[ids.length - 1])
    expect(read.heads).toContain(ids[ids.length - 1])
  })
})

describe('evidence order', () => {
  it('puts an environment after the one it takes evidence from, otherwise by rank and slug, and loses none in a cycle', () => {
    const env = (slug: string, evidenceFrom: string | null, rank: number) => ({
      slug,
      evidenceFrom,
      rank,
    })
    expect(
      evidenceOrder([
        env('production', 'staging', 0),
        env('preview-b', null, 3),
        env('staging', 'dev', 1),
        env('dev', null, 2),
        env('preview-a', null, 3),
      ]).map((e) => e.slug),
    ).toEqual(['dev', 'staging', 'production', 'preview-a', 'preview-b'])
    // A registered cycle cannot exist; a corrupt one still terminates.
    expect(evidenceOrder([env('a', 'b', 0), env('b', 'a', 0)])).toHaveLength(2)
  })
})
