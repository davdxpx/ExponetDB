import { newId } from '@exponetdb/kernel'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ControlStoreRole, loadBundleSet, migrateControlStore } from '../src/index.ts'
import {
  createTestDatabase,
  type MigratedTestDatabase,
  migratedTestDatabase,
} from '../src/testing/index.ts'
import { bundleDir } from './fixtures.ts'

/**
 * The Wave 4 schemas (`registry`, `observation`) against PostgreSQL 17:
 * what the database refuses whatever a process sends. Grants are exercised,
 * never read.
 */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_registry')
})

afterAll(async () => {
  await db?.drop()
})

type Client = pg.Client
const now = () => Date.now()
const CA = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n'

async function as<T>(role: ControlStoreRole | 'super', fn: (c: Client) => Promise<T>): Promise<T> {
  return role === 'super' ? db.asSuperuser(fn) : db.asRole(role, fn)
}

async function refused(role: ControlStoreRole | 'super', sql: string, params: unknown[] = []) {
  return as(role, async (c) => {
    try {
      await c.query(sql, params)
      return undefined
    } catch (error) {
      const code: unknown =
        typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
      return typeof code === 'string' ? code : 'unknown'
    }
  })
}

async function op(): Promise<string> {
  const id = newId('op', now())
  await as('super', (c) =>
    c.query(
      `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                          actor_kind, client_kind)
       VALUES ($1, 'registry.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [id],
    ),
  )
  return id
}

const worker = <T>(fn: (c: Client) => Promise<T>) => as('exdb_worker', fn)

interface World {
  product: string
  staging: string
  production: string
  project: string
  cluster: string
  database: string
}

async function world(
  slug = `p${now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
): Promise<World> {
  const o = await op()
  const w: World = {
    product: newId('prd', now()),
    staging: newId('env', now()),
    production: newId('env', now()),
    project: newId('prj', now()),
    cluster: newId('cls', now()),
    database: newId('dbs', now()),
  }
  await worker(async (c) => {
    await c.query(
      `INSERT INTO registry.products (product_id, slug, display_name, created_by_operation_id) VALUES ($1, $2, 'P', $3)`,
      [w.product, slug, o],
    )
    await c.query(
      `INSERT INTO registry.environments (environment_id, product_id, slug, display_name, tier, created_by_operation_id)
       VALUES ($1, $2, 'staging', 'Staging', 'nonprod', $3)`,
      [w.staging, w.product, o],
    )
    await c.query(
      `INSERT INTO registry.environments (environment_id, product_id, slug, display_name, tier, evidence_from, created_by_operation_id)
       VALUES ($1, $2, 'production', 'Production', 'prod', $3, $4)`,
      [w.production, w.product, w.staging, o],
    )
    await c.query(
      `INSERT INTO registry.projects (project_id, product_id, slug, display_name, managed_scope, created_by_operation_id)
       VALUES ($1, $2, 'platform', 'Platform', '{"excludeSchemas": []}', $3)`,
      [w.project, w.product, o],
    )
    await c.query(
      `INSERT INTO registry.clusters (cluster_id, management_mode, display_name, state, ca_bundle, created_by_operation_id)
       VALUES ($1, 'external', 'main', 'pending', $2, $3)`,
      [w.cluster, CA, o],
    )
    await c.query(
      `UPDATE registry.clusters SET state = 'active', system_identifier = '7400000000000000001', server_version_num = 170011,
              confirmed_by_operation_id = $2 WHERE cluster_id = $1`,
      [w.cluster, o],
    )
    await c.query(
      `INSERT INTO registry.databases (database_id, cluster_id, name, state, created_by_operation_id)
       VALUES ($1, $2, 'app_db', 'registered', $3)`,
      [w.database, w.cluster, o],
    )
  })
  return w
}

async function target(w: World, environment: string, path: string): Promise<string> {
  const id = newId('tgt', now())
  const o = await op()
  await worker((c) =>
    c.query(
      `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                     created_by_operation_id, state_changed_at, state_changed_by_operation_id)
       VALUES ($1, $2, $3, $4, (SELECT tier FROM registry.environments WHERE environment_id = $3), 1, 'registered', $5, now(), $5)`,
      [id, w.project, environment, path, o],
    ),
  )
  return id
}

describe('registry guards', () => {
  it('keeps slugs, paths and tiers consistent and immutable', async () => {
    const w = await world()
    const slug = (
      await worker((c) =>
        c.query('SELECT slug FROM registry.products WHERE product_id = $1', [w.product]),
      )
    ).rows[0]?.slug as string
    const t = await target(w, w.staging, `${slug}/platform/staging`)
    // a wrong path or tier is refused
    const o = await op()
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                       created_by_operation_id, state_changed_at, state_changed_by_operation_id)
         VALUES ($1, $2, $3, 'other/platform/production', 'prod', 1, 'registered', $4, now(), $4)`,
        [newId('tgt', now()), w.project, w.production, o],
      ),
    ).toBe('EXG10')
    // the slug of a product never changes, even for the schema owner
    expect(
      await refused('super', 'UPDATE registry.products SET slug = $2 WHERE product_id = $1', [
        w.product,
        'x',
      ]),
    ).toBe('EXG01')
    // the path of a target never changes; serve cannot even try
    expect(
      await refused('exdb_worker', 'UPDATE registry.targets SET path = $2 WHERE target_id = $1', [
        t,
        'a/b/c',
      ]),
    ).toBe('42501')
    expect(
      await refused('super', 'UPDATE registry.targets SET path = $2 WHERE target_id = $1', [
        t,
        'a/b/c',
      ]),
    ).toBe('EXG10')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE registry.targets SET state = 'active' WHERE target_id = $1`,
        [t],
      ),
    ).toBe('42501')
    // a second target with the same path (the same project and environment) is refused
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                       created_by_operation_id, state_changed_at, state_changed_by_operation_id)
         VALUES ($1, $2, $3, $4, 'nonprod', 1, 'registered', $5, now(), $5)`,
        [newId('tgt', now()), w.project, w.staging, `${slug}/platform/staging`, o],
      ),
    ).toBe('EXG10')
  })

  it('refuses a tier change under a live target and an evidence cycle', async () => {
    const w = await world()
    const slug = (
      await worker((c) =>
        c.query('SELECT slug FROM registry.products WHERE product_id = $1', [w.product]),
      )
    ).rows[0]?.slug as string
    await target(w, w.staging, `${slug}/platform/staging`)
    const o = await op()
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.environments SET tier = 'prod', revision = revision + 1, updated_by_operation_id = $2
          WHERE environment_id = $1`,
        [w.staging, o],
      ),
    ).toBe('EXG03')
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.environments SET evidence_from = $2, revision = revision + 1, updated_by_operation_id = $3
          WHERE environment_id = $1`,
        [w.staging, w.production, o],
      ),
    ).toBe('EXG04')
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.environments SET rank = 5, updated_by_operation_id = $2 WHERE environment_id = $1`,
        [w.staging, o],
      ),
    ).toBe('EXG02')
  })

  it('moves targets only along the documented states and keeps one current placement', async () => {
    const w = await world()
    const slug = (
      await worker((c) =>
        c.query('SELECT slug FROM registry.products WHERE product_id = $1', [w.product]),
      )
    ).rows[0]?.slug as string
    const t = await target(w, w.staging, `${slug}/platform/staging`)
    const t2 = await target(w, w.production, `${slug}/platform/production`)
    const o = await op()
    const placement = newId('plc', now())
    await worker((c) =>
      c.query(
        `INSERT INTO registry.placements (placement_id, target_id, database_id, generation, reason, valid_from, operation_id)
         VALUES ($1, $2, $3, 1, 'initial', now(), $4)`,
        [placement, t, w.database, o],
      ),
    )
    // I-3: the database is already the current placement of a target
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO registry.placements (placement_id, target_id, database_id, generation, reason, valid_from, operation_id)
         VALUES ($1, $2, $3, 1, 'initial', now(), $4)`,
        [newId('plc', now()), t2, w.database, o],
      ),
    ).toBe('23505')
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.targets SET state = 'suspended', state_changed_by_operation_id = $2 WHERE target_id = $1`,
        [t, o],
      ),
    ).toBe('EXG10')
    const o2 = await op()
    await worker((c) =>
      c.query(
        `UPDATE registry.targets SET state = 'active', state_changed_by_operation_id = $2 WHERE target_id = $1`,
        [t, o2],
      ),
    )
    expect(
      await refused(
        'exdb_worker',
        'UPDATE registry.targets SET generation = 0 WHERE target_id = $1',
        [t],
      ),
    ).toBe('EXG10')
    expect(
      await refused('exdb_worker', 'DELETE FROM registry.placements WHERE placement_id = $1', [
        placement,
      ]),
    ).toBe('42501')
    expect(
      await refused('super', 'DELETE FROM registry.placements WHERE placement_id = $1', [
        placement,
      ]),
    ).toBe('EXA01')
    // a decommissioned target keeps its path: a new target never takes it again
    const o3 = await op()
    await worker((c) =>
      c.query(
        `UPDATE registry.placements SET valid_to = now(), ended_by_operation_id = $2 WHERE placement_id = $1`,
        [placement, o3],
      ),
    )
    await worker((c) =>
      c.query(
        `UPDATE registry.targets SET state = 'decommissioned', state_changed_by_operation_id = $2 WHERE target_id = $1`,
        [t, o3],
      ),
    )
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                       created_by_operation_id, state_changed_at, state_changed_by_operation_id)
         VALUES ($1, $2, $3, $4, 'nonprod', 1, 'registered', $5, now(), $5)`,
        [newId('tgt', now()), w.project, w.staging, `${slug}/platform/staging`, o3],
      ),
    ).toBe('EXG10')
  })

  it('pins a cluster system identifier once', async () => {
    const w = await world()
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.clusters SET system_identifier = '1' WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBe('EXG07')
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO registry.clusters (cluster_id, management_mode, display_name, state, system_identifier, ca_bundle,
                                        confirmed_at, created_by_operation_id)
         VALUES ($1, 'external', 'x', 'active', '2', $2, now(), $3)`,
        [newId('cls', now()), CA, await op()],
      ),
    ).toBe('EXG07')
  })

  it('requires a TLS server name equal to a DNS host and allows an explicit one for an IP host', async () => {
    const w = await world()
    const o = await op()
    const insert = (host: string, name: string) =>
      refused(
        'exdb_worker',
        `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, host, port, tls_server_name, label, state, created_by_operation_id)
         VALUES ($1, $2, 'private', $3, 5432, $4, 'private', 'active', $5)`,
        [newId('end', now()), w.cluster, host, name, o],
      )
    expect(await insert('db.example.test', 'other.example.test')).toBe('23514')
    expect(await insert('db.example.test', 'db.example.test')).toBeUndefined()
    expect(await insert('10.8.1.2', 'db.example.test')).toBeUndefined()
    expect(await insert('postgres://u:p@h', 'h')).toBe('23514')
    expect(await insert('10.8.1.3', '10.8.1.3')).toBe('23514')
  })

  it('binds a credential to a secret of its own cluster, role and consumer', async () => {
    const w = await world()
    const secret = newId('sec', now())
    const subject = `${w.cluster}/exponetdb_observer`
    await as('super', (c) =>
      c.query(
        `INSERT INTO secrets.secret_versions (secret_id, version, purpose, subject_id, consumer, created_by)
         VALUES ($1, 1, 'pg_credential', $2, 'observer', 'test')`,
        [secret, subject],
      ),
    )
    const insert = (role: string, roleName: string) =>
      refused(
        'exdb_serve',
        `INSERT INTO registry.credentials (credential_id, cluster_id, access_role, role_name, secret_id, secret_version,
                                           state, submitted_at, submitted_by, state_changed_at)
         VALUES ($1, $2, $3, $4, $5, 1, 'pending', now(), $6, now())`,
        [newId('crd', now()), w.cluster, role, roleName, secret, newId('idn', now())],
      )
    expect(await insert('reader', 'exponetdb_reader')).toBe('EXG12')
    expect(await insert('observer', 'postgres')).toBe('EXG12')
    expect(await insert('observer', 'exponetdb_observer')).toBeUndefined()
    // serve holds UPDATE (state, failure_code) to supersede a pending
    // submission; the guard refuses every other change from serve.
    expect(
      await refused(
        'exdb_serve',
        `UPDATE registry.credentials SET state = 'active' WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBe('EXG12')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE registry.credentials SET state = 'failed', failure_code = 'login_failed' WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBe('EXG12')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE registry.credentials SET secret_version = 2 WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBe('42501')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE registry.credentials SET verified_at = now() WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBe('42501')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE registry.credentials SET state = 'failed', failure_code = 'superseded' WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBeUndefined()
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.credentials SET state = 'active' WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBe('EXG12')
  })
})

describe('observation guards', () => {
  it('keeps history append-only, baselines complete and findings open once', async () => {
    const w = await world()
    const slug = (
      await worker((c) =>
        c.query('SELECT slug FROM registry.products WHERE product_id = $1', [w.product]),
      )
    ).rows[0]?.slug as string
    const t = await target(w, w.staging, `${slug}/platform/staging`)
    const fp = `fp1:17:${'a'.repeat(64)}`
    const incomplete = newId('smp', now())
    const complete = newId('smp', now())
    const o = await op()
    await worker(async (c) => {
      await c.query(
        `INSERT INTO observation.schema_documents (fingerprint, pg_major, entries, document, document_digest)
         VALUES ($1, 17, 0, '\\x00', $2) ON CONFLICT DO NOTHING`,
        [fp, `sha256:${'b'.repeat(64)}`],
      )
      await c.query(
        `INSERT INTO observation.schema_snapshots (snapshot_id, target_id, generation, fingerprint, complete, visibility,
                                                   server_version_num, purpose, duration_ms)
         VALUES ($1, $2, 1, $3, false, '[{"class":"view"}]', 170011, 'registration', 5)`,
        [incomplete, t, fp],
      )
      await c.query(
        `INSERT INTO observation.schema_snapshots (snapshot_id, target_id, generation, fingerprint, complete, visibility,
                                                   server_version_num, purpose, duration_ms)
         VALUES ($1, $2, 1, $3, true, '[]', 170011, 'registration', 5)`,
        [complete, t, fp],
      )
    })
    const baseline = (snapshot: string) =>
      refused(
        'exdb_worker',
        `INSERT INTO observation.schema_baselines (baseline_id, target_id, generation, snapshot_id, fingerprint, reason, operation_id)
         VALUES ($1, $2, 1, $3, $4, 'registration', $5)`,
        [newId('smp', now()), t, snapshot, fp, o],
      )
    expect(await baseline(incomplete)).toBe('EXH02')
    expect(await baseline(complete)).toBeUndefined()
    expect(
      await refused('exdb_serve', `INSERT INTO observation.schema_baselines VALUES ('x')`),
    ).toBe('42501')
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO observation.schema_snapshots (snapshot_id, target_id, generation, fingerprint, complete, visibility,
                                                   server_version_num, purpose, duration_ms)
         VALUES ($1, $2, 1, $3, true, '[{"class":"view"}]', 170011, 'read', 5)`,
        [newId('smp', now()), t, fp],
      ),
    ).toBe('23514')
    expect(
      await refused(
        'exdb_worker',
        'UPDATE observation.schema_snapshots SET complete = true WHERE snapshot_id = $1',
        [incomplete],
      ),
    ).toBe('42501')
    expect(
      await refused('super', 'DELETE FROM observation.schema_snapshots WHERE snapshot_id = $1', [
        incomplete,
      ]),
    ).toBe('EXA01')

    const finding = (id: string) =>
      refused(
        'exdb_serve',
        `INSERT INTO observation.findings (finding_id, target_id, kind, code, severity, dedup_key, summary, state,
                                           first_seen_at, last_seen_at)
         VALUES ($1, $2, 'drift', 'object_changed', 'warning', 'table:public.t', 'changed', 'open', now(), now())`,
        [id, t],
      )
    const f1 = newId('fnd', now())
    expect(await finding(f1)).toBeUndefined()
    expect(await finding(newId('fnd', now()))).toBe('23505')
    expect(
      await refused(
        'exdb_serve',
        'UPDATE observation.findings SET occurrences = occurrences + 5 WHERE finding_id = $1',
        [f1],
      ),
    ).toBe('EXH01')
    await as('exdb_serve', (c) =>
      c.query(
        `UPDATE observation.findings SET state = 'resolved', resolution = 'cleared' WHERE finding_id = $1`,
        [f1],
      ),
    )
    expect(
      await refused(
        'exdb_serve',
        `UPDATE observation.findings SET state = 'open' WHERE finding_id = $1`,
        [f1],
      ),
    ).toBe('EXH01')
    expect(await finding(newId('fnd', now()))).toBeUndefined()
  })

  it('creates and drops daily sample partitions only through the owner functions', async () => {
    await as('exdb_worker', (c) => c.query('SELECT observation.ensure_sample_partitions(3)'))
    expect(await refused('exdb_serve', 'SELECT observation.ensure_sample_partitions(3)')).toBe(
      '42501',
    )
    expect(
      await refused('exdb_worker', 'SELECT observation.drop_expired_sample_partitions(1)'),
    ).toBe('22023')
    const dropped = await as('exdb_worker', (c) =>
      c.query('SELECT observation.drop_expired_sample_partitions(3) AS n'),
    )
    expect(Number(dropped.rows[0]?.n)).toBe(0)
    expect(await refused('exdb_worker', 'CREATE TABLE observation.x (id int)')).toBe('42501')
  })
})

describe('upgrade from the accepted G3B schema', () => {
  it('applies the two Wave 4 bundles on top of the ten G3B bundles, verifies all, then is a no-op', async () => {
    const fresh = await createTestDatabase('exdb_it_registry_upgrade')
    const g3b = await bundleDir()
    try {
      await g3b.keepOnly([
        '01M46KHY8',
        '01M46KHZ7',
        '01M46KJ06',
        '01M46KJ15',
        '01M46KJ25',
        '01M46KJ34',
        '01M46VP9A',
        '01M47XQ56',
      ])
      const store = fresh.store('exdb_migrate', { poolMax: 2 })
      const before = await migrateControlStore({
        store,
        bundles: await loadBundleSet(g3b.path),
        engineVersion: 'g3b',
        newInstallationId: () => newId('ins', now()),
      })
      expect(before.applied).toHaveLength(10)
      const after = await migrateControlStore({
        store,
        bundles: await loadBundleSet(),
        engineVersion: 'wave-4',
        newInstallationId: () => newId('ins', now()),
      })
      expect(after.installationId).toBe(before.installationId)
      expect(after.applied).toEqual(['01M48WRFNFYAY62E1146END05N', '01M48WRFNGYF5WH0884N169FNH'])
      expect(after.verifications.every((v) => v.status === 'passed')).toBe(true)
      expect(after.state.status).toBe('current')
      const again = await migrateControlStore({
        store,
        bundles: await loadBundleSet(),
        engineVersion: 'wave-4',
        newInstallationId: () => newId('ins', now()),
      })
      expect(again.applied).toEqual([])
    } finally {
      await g3b.remove()
      await fresh.drop()
    }
  })
})
