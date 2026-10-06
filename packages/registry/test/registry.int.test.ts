import { CONTROL_STORE_ROLES, loadBundleSet } from '@exponetdb/control-store'
import { readOperation } from '@exponetdb/operations'
import { stampTarget, TargetSession } from '@exponetdb/postgres'
import { runAsSuperuser, serverFor, type TestServer, withSuperuser } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  credentialView,
  findTarget,
  getCluster,
  listCredentials,
  listEndpoints,
  listTargets,
  planClusterConfirm,
  planClusterRegister,
  planDatabaseRegister,
  planEndpointAdd,
  planEndpointRetire,
  planEnvironmentCreate,
  planEnvironmentUpdate,
  planProductCreate,
  planProjectCreate,
  planTargetRegister,
  planTargetStateChange,
  type RegistryActor,
  RegistryError,
  registryChains,
} from '../src/index.ts'
import {
  accept,
  actor,
  drive,
  endpointFor,
  ensureRoles,
  type Harness,
  harness,
  password,
  plan,
  run,
  submit,
  targetDatabase,
  targets,
  verifyCredentials,
} from './harness.ts'

/**
 * The registry on real PostgreSQL: plans, the Operations Engine and the
 * registry kinds against a migrated Control Store and the TLS test servers.
 * G4 items: target.register is the only data-plane write; it refuses a
 * Control Store, another installation's or target's marker and a cluster
 * whose address now reaches another cluster; it is idempotent and needs
 * approval for production; credentials are write-only and verified over
 * verified TLS.
 */
let h: Harness
let a: RegistryActor
const pg17: TestServer = serverFor(17)
const ids: {
  product: string
  staging: string
  production: string
  project: string
  cluster: string
} = { product: '', staging: '', production: '', project: '', cluster: '' }
const slug = `acme${Date.now().toString(36)}`
const clusters = new Map<16 | 18, string>()

async function refusedWith(promise: Promise<unknown>): Promise<RegistryError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RegistryError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

async function content(planId: string): Promise<Record<string, unknown>> {
  const { rows } = await h.worker.query(
    'test.plan.content',
    `SELECT (b.body::jsonb)->'content' AS c FROM operations.plan_bodies b WHERE b.plan_id = $1`,
    [planId],
  )
  return rows[0]?.json('c') as Record<string, unknown>
}

async function databaseId(name: string, clusterId: string): Promise<string> {
  const { rows } = await h.worker.query(
    'test.database.id',
    `SELECT database_id FROM registry.databases WHERE cluster_id = $1 AND name = $2 AND state = 'registered'`,
    [clusterId, name],
  )
  const id = rows[0]?.text('database_id')
  if (id === undefined) throw new Error(`database ${name} not registered`)
  return id
}

/**
 * Registers, confirms and credentials a cluster for a test server (one
 * address per cluster). The roles are created first: a fresh server has
 * none, and no other suite may be relied on to have made them.
 */
async function readyCluster(server: TestServer, via: 'ip' | 'localhost' = 'ip'): Promise<string> {
  await ensureRoles(server)
  const reg = await run(h, a, (tx) =>
    planClusterRegister(tx, h.context, a, {
      displayName: `pg${server.major} ${via}`,
      caBundle: targets().caPem,
      endpoints: [endpointFor(server, via)],
    }),
  )
  expect(reg.operation.state).toBe('succeeded')
  const clusterId = (await content(reg.plan.planId))['clusterId'] as string
  await submit(h, a, clusterId, 'observer')
  await verifyCredentials(h)
  const confirm = await run(h, a, (tx) => planClusterConfirm(tx, h.context, a, clusterId, {}))
  expect(confirm.operation.state).toBe('succeeded')
  await submit(h, a, clusterId, 'migrator')
  await submit(h, a, clusterId, 'reader')
  await verifyCredentials(h)
  return clusterId
}

async function registerDatabase(clusterId: string, name: string): Promise<string> {
  const r = await run(h, a, (tx) => planDatabaseRegister(tx, h.context, a, clusterId, { name }))
  expect(r.operation.state).toBe('succeeded')
  return databaseId(name, clusterId)
}

beforeAll(async () => {
  h = await harness()
  a = actor()
  // ExponetDB's roles on the PostgreSQL 17 server, from the product
  // bootstrap SQL: a fresh server has none (CI starts fresh servers).
  await ensureRoles(pg17)
  const product = await run(h, a, (tx) =>
    planProductCreate(tx, h.context, a, { slug, displayName: 'Acme' }),
  )
  ids.product = (await content(product.plan.planId))['productId'] as string
  const staging = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, ids.product, {
      slug: 'staging',
      displayName: 'Staging',
      tier: 'nonprod',
    }),
  )
  ids.staging = (await content(staging.plan.planId))['environmentId'] as string
  const production = await run(h, a, (tx) =>
    planEnvironmentCreate(tx, h.context, a, ids.product, {
      slug: 'production',
      displayName: 'Production',
      tier: 'prod',
      evidenceFrom: 'staging',
    }),
  )
  ids.production = (await content(production.plan.planId))['environmentId'] as string
  const project = await run(h, a, (tx) =>
    planProjectCreate(tx, h.context, a, {
      product: slug,
      slug: 'platform',
      displayName: 'Platform',
      managedScope: { excludeSchemas: ['audit_archive'] },
    }),
  )
  ids.project = (await content(project.plan.planId))['projectId'] as string
  for (const r of [product, staging, production, project]) {
    expect(r.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
  }
})

afterAll(async () => {
  await h?.close()
})

describe('organization: products, environments, projects', () => {
  it('records each change through its plan and operation, with the operation id on the row', async () => {
    const { rows } = await h.worker.query(
      'test.env.rows',
      `SELECT slug, tier, revision, (created_by_operation_id IS NOT NULL) AS by_op FROM registry.environments
        WHERE product_id = $1 ORDER BY slug`,
      [ids.product],
    )
    expect(
      rows.map((r) => [r.text('slug'), r.text('tier'), r.int('revision'), r.bool('by_op')]),
    ).toEqual([
      ['production', 'prod', 1, true],
      ['staging', 'nonprod', 1, true],
    ])
  })

  it('refuses a duplicate slug and an evidence cycle at planning', async () => {
    expect(
      (
        await refusedWith(
          plan(h, (tx) => planProductCreate(tx, h.context, a, { slug, displayName: 'x' })),
        )
      ).details,
    ).toEqual({ reason: 'slug_taken' })
    expect(
      (
        await refusedWith(
          plan(h, (tx) =>
            planEnvironmentUpdate(tx, h.context, a, ids.product, ids.staging, {
              evidenceFrom: 'production',
            }),
          ),
        )
      ).details,
    ).toEqual({ reason: 'evidence_cycle' })
  })

  it('makes a stale environment plan fail before anything is written', async () => {
    const p1 = await plan(h, (tx) =>
      planEnvironmentUpdate(tx, h.context, a, ids.product, ids.staging, { rank: 3 }),
    )
    const p2 = await plan(h, (tx) =>
      planEnvironmentUpdate(tx, h.context, a, ids.product, ids.staging, { rank: 4 }),
    )
    await accept(h, p1, a)
    await drive(h)
    await expect(accept(h, p2, a)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    const { rows } = await h.worker.query(
      'test.env.rank',
      'SELECT rank, revision FROM registry.environments WHERE environment_id = $1',
      [ids.staging],
    )
    expect([rows[0]?.int('rank'), rows[0]?.int('revision')]).toEqual([3, 2])
  })
})

describe('external cluster: register, observer credential, confirmation', () => {
  it('registers a pending cluster, verifies the observer over TLS and pins the system identifier', async () => {
    const reg = await run(h, a, (tx) =>
      planClusterRegister(tx, h.context, a, {
        displayName: 'pg17',
        caBundle: targets().caPem,
        endpoints: [endpointFor(pg17)],
      }),
    )
    ids.cluster = (await content(reg.plan.planId))['clusterId'] as string
    expect((await getCluster(h.worker, ids.cluster))?.state).toBe('pending')
    const certificates = (
      reg.plan.body['analysis'] as { caCertificates: { ca: boolean; subject: string }[] }
    ).caCertificates
    expect(certificates.length).toBe(1)
    expect(certificates[0]?.ca).toBe(true)

    // Only the observer can be submitted before confirmation.
    expect((await refusedWith(submit(h, a, ids.cluster, 'migrator'))).details).toEqual({
      reason: 'cluster_not_confirmed',
    })
    expect(
      (await refusedWith(plan(h, (tx) => planClusterConfirm(tx, h.context, a, ids.cluster, {}))))
        .details,
    ).toEqual({ reason: 'observer_credential_missing' })

    const submitted = await submit(h, a, ids.cluster, 'observer')
    expect(submitted.state).toBe('pending')
    expect(await verifyCredentials(h)).toEqual([
      { credentialId: submitted.credentialId, state: 'active' },
    ])

    const expected = await withSuperuser(pg17, 'postgres', async (c) =>
      String(
        (await c.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0]?.s,
      ),
    )
    const wrong = await refusedWith(
      plan(h, (tx) => planClusterConfirm(tx, h.context, a, ids.cluster, { systemIdentifier: '1' })),
    )
    expect(wrong.code).toBe('CLUSTER_IDENTITY_MISMATCH')
    const confirm = await run(h, a, (tx) =>
      planClusterConfirm(tx, h.context, a, ids.cluster, { systemIdentifier: expected }),
    )
    expect(confirm.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const cluster = await getCluster(h.worker, ids.cluster)
    expect(cluster).toMatchObject({ state: 'active', systemIdentifier: expected })
    expect(cluster?.serverVersionNum).toBeGreaterThanOrEqual(170000)
  })

  it('verifies the migrator and reader, and fails a wrong password without retrying it', async () => {
    await submit(h, a, ids.cluster, 'migrator')
    await submit(h, a, ids.cluster, 'reader')
    const wrong = await submit(h, a, ids.cluster, 'operator', 'not-the-password-0123456789')
    const results = await verifyCredentials(h)
    expect(results).toContainEqual({ credentialId: wrong.credentialId, state: 'failed' })
    const list = await listCredentials(h.worker, ids.cluster)
    const active = list
      .filter((c) => c.state === 'active')
      .map((c) => c.accessRole)
      .sort()
    expect(active).toEqual(['migrator', 'observer', 'reader'])
    expect(list.find((c) => c.credentialId === wrong.credentialId)?.failureCode).toBe(
      'authentication_failed',
    )
  })

  it('never shows a secret: the credential view has metadata only', async () => {
    const list = await listCredentials(h.worker, ids.cluster)
    for (const c of list) {
      const view = credentialView(c)
      const text = JSON.stringify(view)
      expect(Object.keys(view)).not.toContain('secretId')
      expect(text).not.toContain(c.secretId)
      expect(text).not.toContain(password('observer'))
    }
  })

  it('supersedes a pending submission and retires the active credential it replaces', async () => {
    const first = await submit(h, a, ids.cluster, 'reader', 'a-first-wrong-password-xyz')
    const second = await submit(h, a, ids.cluster, 'reader')
    await verifyCredentials(h)
    const list = await listCredentials(h.worker, ids.cluster)
    expect(list.find((c) => c.credentialId === first.credentialId)).toMatchObject({
      state: 'failed',
      failureCode: 'superseded',
    })
    const readers = list.filter((c) => c.accessRole === 'reader')
    expect(readers.filter((c) => c.state === 'active').map((c) => c.credentialId)).toEqual([
      second.credentialId,
    ])
    expect(readers.some((c) => c.state === 'retired')).toBe(true)
  })
})

describe('target.register (the only data-plane write)', () => {
  it('registers a nonprod target: marker, empty ledger, read-back, snapshot, active', async () => {
    const name = await targetDatabase(pg17, 'reg')
    const dbId = await registerDatabase(ids.cluster, name)
    const r = await run(h, a, (tx) =>
      planTargetRegister(tx, h.context, a, {
        projectId: ids.project as never,
        environmentId: ids.staging as never,
        databaseId: dbId as never,
      }),
    )
    expect(r.operation).toMatchObject({
      state: 'succeeded',
      applyOutcome: 'applied',
      verificationOutcome: 'passed',
    })
    expect(r.plan.decision).toBe('allow')
    const target = await findTarget(h.worker, `${slug}/platform/staging`)
    expect(target).toMatchObject({ state: 'active', generation: 1, tier: 'nonprod' })
    expect(h.snapshots.taken.get(r.operation.operationId)?.targetId).toBe(target?.targetId)
    // The database carries exactly one marker naming this installation, target and generation.
    const markers = await withSuperuser(pg17, name, (c) =>
      c.query(
        'SELECT installation_id, target_id, target_path, tier, generation FROM exponetdb.target_identity',
      ),
    )
    expect(markers.rows).toEqual([
      {
        installation_id: h.db.installationId,
        target_id: target?.targetId,
        target_path: `${slug}/platform/staging`,
        tier: 'nonprod',
        generation: 1,
      },
    ])

    // Applying the same plan again is the same operation, not a second registration.
    const again = await accept(h, r.plan, a)
    expect(again.operationId).toBe(r.operation.operationId)
    await drive(h)
    const count = await withSuperuser(pg17, name, (c) =>
      c.query('SELECT count(*)::int AS n FROM exponetdb.target_identity'),
    )
    expect(count.rows[0]?.n).toBe(1)
  })

  it('refuses a second target at the same path and makes a racing plan stale', async () => {
    const name = await targetDatabase(pg17, 'race')
    const dbId = await registerDatabase(ids.cluster, name)
    const taken = await refusedWith(
      plan(h, (tx) =>
        planTargetRegister(tx, h.context, a, {
          projectId: ids.project as never,
          environmentId: ids.staging as never,
          databaseId: dbId as never,
        }),
      ),
    )
    expect(taken.details).toEqual({ reason: 'path_taken' })

    // Two plans for the same new path: the second one is stale once the first ran.
    const projectB = await run(h, a, (tx) =>
      planProjectCreate(tx, h.context, a, {
        product: slug,
        slug: 'billing',
        displayName: 'Billing',
      }),
    )
    const project = (await content(projectB.plan.planId))['projectId'] as string
    const other = await targetDatabase(pg17, 'race2')
    const otherId = await registerDatabase(ids.cluster, other)
    const p1 = await plan(h, (tx) =>
      planTargetRegister(tx, h.context, a, {
        projectId: project as never,
        environmentId: ids.staging as never,
        databaseId: dbId as never,
      }),
    )
    const p2 = await plan(h, (tx) =>
      planTargetRegister(tx, h.context, a, {
        projectId: project as never,
        environmentId: ids.staging as never,
        databaseId: otherId as never,
      }),
    )
    await accept(h, p1, a)
    await drive(h)
    await expect(accept(h, p2, a)).rejects.toMatchObject({ code: 'PLAN_STALE' })
    const untouched = await withSuperuser(pg17, other, (c) =>
      c.query(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'exponetdb') AS present`),
    )
    expect(untouched.rows[0]?.present).toBe(false)
  })

  it('leaves a target registered when registration stops after the stamp, and resumes it', async () => {
    const env = await run(h, a, (tx) =>
      planEnvironmentCreate(tx, h.context, a, ids.product, {
        slug: 'resume',
        displayName: 'Resume',
        tier: 'nonprod',
      }),
    )
    const environmentId = (await content(env.plan.planId))['environmentId'] as string
    const name = await targetDatabase(pg17, 'resume')
    const dbId = await registerDatabase(ids.cluster, name)
    const input = {
      projectId: ids.project as never,
      environmentId: environmentId as never,
      databaseId: dbId as never,
    }
    h.snapshots.fail = true
    let first: Awaited<ReturnType<typeof run>>
    try {
      first = await run(h, a, (tx) => planTargetRegister(tx, h.context, a, input))
    } finally {
      h.snapshots.fail = false
    }
    // Applied (the marker is written) but not verified: the target stays registered.
    expect(first.operation).toMatchObject({
      state: 'verification_failed',
      applyOutcome: 'applied',
    })
    const path = `${slug}/platform/resume`
    const registered = await findTarget(h.worker, path)
    expect(registered?.state).toBe('registered')
    const { rows } = await h.worker.query(
      'test.events.snapshot_failed',
      `SELECT 1 FROM operations.operation_events WHERE operation_id = $1 AND detail->>'step' = 'registration_snapshot_failed'`,
      [first.operation.operationId],
    )
    expect(rows.length).toBe(1)
    // Planning again resumes the same target and placement; the stamp is a no-op.
    const second = await run(h, a, (tx) => planTargetRegister(tx, h.context, a, input))
    expect((await content(second.plan.planId))['targetId']).toBe(registered?.targetId)
    expect(second.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    expect((await findTarget(h.worker, path))?.state).toBe('active')
    const markers = await withSuperuser(pg17, name, (c) =>
      c.query('SELECT count(*)::int AS n FROM exponetdb.target_identity'),
    )
    expect(markers.rows[0]?.n).toBe(1)
  })

  it('requires approval and re-authentication for a production target', async () => {
    const name = await targetDatabase(pg17, 'prod')
    const dbId = await registerDatabase(ids.cluster, name)
    const p = await plan(h, (tx) =>
      planTargetRegister(tx, h.context, a, {
        projectId: ids.project as never,
        environmentId: ids.production as never,
        databaseId: dbId as never,
      }),
    )
    expect(p.decision).toBe('require')
    const requirements = (p.body['policy'] as { requirements: { kind: string }[] }).requirements
    expect(requirements.map((r) => r.kind).sort()).toEqual(['approval', 'reauth'])
    const analysis = p.body['analysis'] as { production: boolean; writes: string[] }
    expect(analysis.production).toBe(true)
    expect(analysis.writes.join(' ')).toContain('target_identity')
    const operation = await accept(h, p, a)
    expect(operation.state).toBe('awaiting_approval')
    await drive(h)
    // Nothing ran: no marker, no target row beyond the plan.
    expect((await readOperation(h.worker, operation.operationId))?.state).toBe('awaiting_approval')
    const schema = await withSuperuser(pg17, name, (c) =>
      c.query(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'exponetdb') AS present`),
    )
    expect(schema.rows[0]?.present).toBe(false)
  })

  it('refuses a database marked by another installation or by another target, changing nothing', async () => {
    const env = await run(h, a, (tx) =>
      planEnvironmentCreate(tx, h.context, a, ids.product, {
        slug: 'qa',
        displayName: 'QA',
        tier: 'nonprod',
      }),
    )
    const qa = (await content(env.plan.planId))['environmentId'] as string
    for (const [installation, target, reason] of [
      ['ins_01M4A000000000000000000099', 'tgt_01M4A000000000000000000098', 'foreign_installation'],
      [h.db.installationId, 'tgt_01M4A000000000000000000097', 'other_target'],
    ] as const) {
      const name = await targetDatabase(pg17, reason.slice(0, 8))
      const session = await TargetSession.open(
        {
          endpoint: {
            host: pg17.host,
            port: pg17.port,
            tlsServerName: targets().serverName,
            caPem: targets().caPem,
          },
          database: name,
          role: 'migrator',
          user: 'exponetdb_migrator',
          password: password('migrator'),
          applicationName: 'exponetdb/test',
        },
        {},
      )
      try {
        await stampTarget(
          session,
          {
            installationId: installation,
            targetId: target,
            targetPath: 'other/app/qa',
            tier: 'nonprod',
            generation: 1,
            operationId: 'op_01M4A000000000000000000096',
            projectId: 'prj_01M4A000000000000000000095',
          },
          session.facts.systemIdentifier,
        )
      } finally {
        await session.close()
      }
      const dbId = await registerDatabase(ids.cluster, name)
      const refused = await refusedWith(
        plan(h, (tx) =>
          planTargetRegister(tx, h.context, a, {
            projectId: ids.project as never,
            environmentId: qa as never,
            databaseId: dbId as never,
          }),
        ),
      )
      expect(refused.code).toBe('TARGET_REGISTRATION_REFUSED')
      expect(refused.details).toEqual({ reason })
      const marker = await withSuperuser(pg17, name, (c) =>
        c.query('SELECT target_id FROM exponetdb.target_identity'),
      )
      expect(marker.rows).toEqual([{ target_id: target }])
    }
  })

  it('refuses a real Control Store, even under another database name', async () => {
    const name = await targetDatabase(pg17, 'cscopy')
    // A Control Store schema built by the shipped bundles themselves (the
    // roles exist without login on the test server); the name is arbitrary.
    await runAsSuperuser(pg17, 'postgres', [
      ...CONTROL_STORE_ROLES.map(
        (r) =>
          `DO $x$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${r}') THEN CREATE ROLE ${r} NOLOGIN; END IF; END $x$`,
      ),
      `GRANT CREATE ON DATABASE "${name}" TO exdb_migrate`,
    ])
    const set = await loadBundleSet()
    await withSuperuser(pg17, name, async (c) => {
      for (const bundle of set.bundles) {
        await c.query('BEGIN')
        await c.query('SET LOCAL ROLE exdb_migrate')
        await c.query(bundle.upSql)
        await c.query('COMMIT')
      }
    })
    const dbId = await registerDatabase(ids.cluster, name)
    const env = await run(h, a, (tx) =>
      planEnvironmentCreate(tx, h.context, a, ids.product, {
        slug: 'cs',
        displayName: 'CS',
        tier: 'nonprod',
      }),
    )
    const cs = (await content(env.plan.planId))['environmentId'] as string
    const refused = await refusedWith(
      plan(h, (tx) =>
        planTargetRegister(tx, h.context, a, {
          projectId: ids.project as never,
          environmentId: cs as never,
          databaseId: dbId as never,
        }),
      ),
    )
    expect(refused.code).toBe('TARGET_REGISTRATION_REFUSED')
    expect(refused.details).toEqual({ reason: 'control_store' })
    const schema = await withSuperuser(pg17, name, (c) =>
      c.query(`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'exponetdb') AS present`),
    )
    expect(schema.rows[0]?.present).toBe(false)
  })

  it('suspends, resumes after checking the marker, decommissions, and never reuses the path', async () => {
    const path = `${slug}/platform/staging`
    const target = await findTarget(h.worker, path)
    if (target === undefined) throw new Error('target')
    const suspend = await run(h, a, (tx) =>
      planTargetStateChange(tx, h.context, a, 'target.suspend', path, { reason: 'maintenance' }),
    )
    expect(suspend.operation.state).toBe('succeeded')
    expect((await findTarget(h.worker, target.targetId))?.state).toBe('suspended')
    const resume = await run(h, a, (tx) =>
      planTargetStateChange(tx, h.context, a, 'target.resume', target.targetId, { reason: 'done' }),
    )
    expect(resume.operation.state).toBe('succeeded')
    const decommission = await plan(h, (tx) =>
      planTargetStateChange(tx, h.context, a, 'target.decommission', path, { reason: 'retired' }),
    )
    expect(decommission.actionClass).toBe('critical')
    await accept(h, decommission, a)
    await drive(h)
    const after = await findTarget(h.worker, target.targetId)
    expect(after?.state).toBe('decommissioned')
    expect(after?.placement).toBeNull()
    expect(await findTarget(h.worker, path)).toBeUndefined()
    // The database is not changed by decommissioning: its marker stays.
    const name = target.placement?.databaseName ?? ''
    const marker = await withSuperuser(pg17, name, (c) =>
      c.query('SELECT target_id FROM exponetdb.target_identity'),
    )
    expect(marker.rows).toEqual([{ target_id: target.targetId }])
    const fresh = await targetDatabase(pg17, 'reuse')
    const dbId = await registerDatabase(ids.cluster, fresh)
    const reused = await refusedWith(
      plan(h, (tx) =>
        planTargetRegister(tx, h.context, a, {
          projectId: ids.project as never,
          environmentId: ids.staging as never,
          databaseId: dbId as never,
        }),
      ),
    )
    expect(reused.details).toEqual({ reason: 'path_taken' })
  })
})

describe('registration on every supported major', () => {
  it.each([16, 18] as const)('registers a target on PostgreSQL %i', async (major) => {
    const server = serverFor(major)
    const clusterId = await readyCluster(server, 'localhost')
    clusters.set(major, clusterId)
    const env = await run(h, a, (tx) =>
      planEnvironmentCreate(tx, h.context, a, ids.product, {
        slug: `pg${major}`,
        displayName: `PG ${major}`,
        tier: 'nonprod',
      }),
    )
    const environmentId = (await content(env.plan.planId))['environmentId'] as string
    const name = await targetDatabase(server, `m${major}`)
    const dbId = await registerDatabase(clusterId, name)
    const r = await run(h, a, (tx) =>
      planTargetRegister(tx, h.context, a, {
        projectId: ids.project as never,
        environmentId: environmentId as never,
        databaseId: dbId as never,
      }),
    )
    expect(r.operation).toMatchObject({ state: 'succeeded', verificationOutcome: 'passed' })
    const marker = await withSuperuser(server, name, (c) =>
      c.query('SELECT target_path, generation FROM exponetdb.target_identity'),
    )
    expect(marker.rows).toEqual([{ target_path: `${slug}/platform/pg${major}`, generation: 1 }])
  })
})

describe('cluster identity', () => {
  it('refuses a cluster whose address now reaches another cluster (no auto-pin)', async () => {
    // The PostgreSQL 16 cluster (with a live target) gets a second endpoint
    // that is really an address of the PostgreSQL 17 server, then its own
    // endpoint is retired: the registry still pins PostgreSQL 16.
    const pg16 = serverFor(16)
    const clusterId = clusters.get(16)
    if (clusterId === undefined) throw new Error('the PostgreSQL 16 cluster')
    const moved = await run(h, a, (tx) =>
      planEndpointAdd(tx, h.context, a, clusterId, endpointFor(pg17, 'localhost')),
    )
    expect(moved.operation.state).toBe('succeeded')
    const first = (await listEndpoints(h.worker, clusterId, 'active')).find(
      (e) => e.port === pg16.port,
    )
    const retire = await run(h, a, (tx) =>
      planEndpointRetire(tx, h.context, a, clusterId, first?.endpointId ?? ''),
    )
    expect(retire.operation.state).toBe('succeeded')
    const name = await targetDatabase(pg17, 'moved')
    const refused = await refusedWith(
      plan(h, (tx) => planDatabaseRegister(tx, h.context, a, clusterId, { name })),
    ).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'CLUSTER_IDENTITY_MISMATCH' })
    // The pinned identifier did not move.
    const cluster = await getCluster(h.worker, clusterId)
    const pinned16 = await withSuperuser(pg16, 'postgres', async (c) =>
      String(
        (await c.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0]?.s,
      ),
    )
    expect(cluster?.systemIdentifier).toBe(pinned16)
  })

  it('fails credential verification against an unknown CA and a server without TLS', async () => {
    const badCa = await run(h, a, (tx) =>
      planClusterRegister(tx, h.context, a, {
        displayName: 'wrong ca',
        caBundle: targets().otherCaPem,
        endpoints: [endpointFor(serverFor(18), 'ip')],
      }),
    )
    const plain = await run(h, a, (tx) =>
      planClusterRegister(tx, h.context, a, {
        displayName: 'plaintext',
        caBundle: targets().caPem,
        endpoints: [
          {
            kind: 'private',
            host: '127.0.0.1',
            port: targets().plaintext.port,
            tlsServerName: targets().serverName,
            label: 'plain',
          },
        ],
      }),
    )
    const results: Record<string, string | null> = {}
    for (const r of [badCa, plain]) {
      const clusterId = (await content(r.plan.planId))['clusterId'] as string
      const c = await submit(h, a, clusterId, 'observer')
      await verifyCredentials(h)
      results[clusterId] =
        (await listCredentials(h.worker, clusterId)).find((x) => x.credentialId === c.credentialId)
          ?.failureCode ?? null
    }
    expect(Object.values(results)).toEqual(['tls_failed', 'tls_failed'])
  })
})

describe('registry reads and subject chains', () => {
  it('lists only visible targets and leaks nothing through the cursor', async () => {
    const all = await listTargets(
      h.worker,
      { all: true, productIds: [], projectIds: [], environmentIds: [], targetIds: [] },
      {},
      { limit: 50 },
    )
    expect(all.items.length).toBeGreaterThanOrEqual(2)
    const one = all.items[0]
    if (one === undefined) throw new Error('no target')
    const restricted = await listTargets(
      h.worker,
      { all: false, productIds: [], projectIds: [], environmentIds: [], targetIds: [one.targetId] },
      {},
      { limit: 1 },
    )
    expect(restricted.items.map((t) => t.targetId)).toEqual([one.targetId])
    expect(restricted.nextCursor).toBeNull()
    const delegated = await listTargets(
      h.worker,
      {
        all: true,
        productIds: [],
        projectIds: [],
        environmentIds: [],
        targetIds: [],
        onlyTiers: ['prod'],
      },
      { tier: 'nonprod' },
      { limit: 50 },
    )
    expect(delegated.items).toEqual([])
  })

  it('resolves subject chains from the registry, never from a request', async () => {
    const chains = registryChains(h.worker)
    const target = (
      await listTargets(
        h.worker,
        { all: true, productIds: [], projectIds: [], environmentIds: [], targetIds: [] },
        {},
        { limit: 1 },
      )
    ).items[0]
    if (target === undefined) throw new Error('no target')
    expect(await chains.target(target.targetId)).toEqual({
      productId: ids.product,
      projectId: target.projectId,
      environmentId: target.environmentId,
      targetId: target.targetId,
      tier: target.tier,
    })
    expect(await chains.target('tgt_01M4A000000000000000000000')).toBeUndefined()
    expect(await chains.targetPath(`${slug}/platform/production`)).toEqual({
      productId: ids.product,
      projectId: ids.project,
      environmentId: ids.production,
      tier: 'prod',
    })
    expect(await chains.cluster(ids.cluster)).toEqual({ tier: 'nonprod' })
    expect(await chains.environment(ids.production)).toEqual({
      productId: ids.product,
      environmentId: ids.production,
      tier: 'prod',
    })
  })
})
