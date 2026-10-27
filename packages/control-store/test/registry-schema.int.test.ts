import { SERVER_PROVIDERS } from '@exponetdb/contracts'
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

let worlds = 0

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
      `UPDATE registry.clusters SET state = 'active', system_identifier = $3, server_version_num = 170011,
              confirmed_by_operation_id = $2 WHERE cluster_id = $1`,
      // One live cluster per system identifier: every world has its own.
      [w.cluster, o, String(7_400_000_000_000_000_000n + BigInt(++worlds))],
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

  it('lets a tier change wait for a registration in flight, then refuses it', async () => {
    const w = await world()
    const slug = (
      await worker((c) =>
        c.query('SELECT slug FROM registry.products WHERE product_id = $1', [w.product]),
      )
    ).rows[0]?.slug as string
    const o = await op()
    const change = `UPDATE registry.environments SET tier = 'prod', revision = revision + 1, updated_by_operation_id = $2
                     WHERE environment_id = $1`
    await worker(async (a) => {
      await a.query('BEGIN')
      await a.query(
        `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                       created_by_operation_id, state_changed_at, state_changed_by_operation_id)
         VALUES ($1, $2, $3, $4, 'nonprod', 1, 'registered', $5, now(), $5)`,
        [newId('tgt', now()), w.project, w.staging, `${slug}/platform/staging`, o],
      )
      // The registration holds the environment row: the tier change cannot commit beside it.
      const blocked = await worker(async (b) => {
        await b.query(`SET lock_timeout = '300ms'`)
        try {
          await b.query(change, [w.staging, o])
          return 'committed'
        } catch (error) {
          return String(Reflect.get(error as object, 'code'))
        }
      })
      expect(blocked).toBe('55P03')
      await a.query('COMMIT')
    })
    // Once the target is live, the tier change is refused.
    expect(await refused('exdb_worker', change, [w.staging, o])).toBe('EXG03')
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
    // One live cluster per system identifier, registry-wide.
    const pinned = (
      await worker((c) =>
        c.query('SELECT system_identifier FROM registry.clusters WHERE cluster_id = $1', [
          w.cluster,
        ]),
      )
    ).rows[0]?.system_identifier as string
    const twin = newId('cls', now())
    const o = await op()
    await worker((c) =>
      c.query(
        `INSERT INTO registry.clusters (cluster_id, management_mode, display_name, state, ca_bundle, created_by_operation_id)
         VALUES ($1, 'external', 'twin', 'pending', $2, $3)`,
        [twin, CA, o],
      ),
    )
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.clusters SET state = 'active', system_identifier = $2, server_version_num = 170011,
                confirmed_by_operation_id = $3 WHERE cluster_id = $1`,
        [twin, pinned, o],
      ),
    ).toBe('23505')
  })

  it('declares a cluster tier only through its own declare_tier operation, never back to undeclared', async () => {
    const w = await world()
    const declareOp = async () => {
      const id = newId('op', now())
      await as('super', (c) =>
        c.query(
          `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                              actor_kind, client_kind)
           VALUES ($1, 'registry.cluster.declare_tier', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
          [id],
        ),
      )
      return id
    }
    const declare = `UPDATE registry.clusters SET declared_tier = $2, declared_tier_by_operation_id = $3 WHERE cluster_id = $1`
    const read = async () =>
      (
        await worker((c) =>
          c.query(
            'SELECT declared_tier, declared_tier_at, declared_tier_by_operation_id FROM registry.clusters WHERE cluster_id = $1',
            [w.cluster],
          ),
        )
      ).rows[0]
    // A cluster starts undeclared, and never registers declared.
    expect(await read()).toMatchObject({ declared_tier: null, declared_tier_at: null })
    expect(
      await refused(
        'exdb_worker',
        `INSERT INTO registry.clusters (cluster_id, management_mode, display_name, state, ca_bundle, created_by_operation_id,
                                        declared_tier, declared_tier_by_operation_id)
         VALUES ($1, 'external', 'x', 'pending', $2, $3, 'prod', $3)`,
        [newId('cls', now()), CA, await declareOp()],
      ),
    ).toBe('EXG07')
    // Only an operation of the declare kind declares; serve never writes it.
    expect(await refused('exdb_worker', declare, [w.cluster, 'prod', await op()])).toBe('EXG07')
    expect(await refused('exdb_serve', declare, [w.cluster, 'prod', await declareOp()])).toBe(
      '42501',
    )
    const first = await declareOp()
    expect(await refused('exdb_worker', declare, [w.cluster, 'prod', first])).toBeUndefined()
    expect(await read()).toMatchObject({
      declared_tier: 'prod',
      declared_tier_at: expect.any(Date),
      declared_tier_by_operation_id: first,
    })
    // Each change is its own operation; a declared tier is never removed.
    expect(await refused('exdb_worker', declare, [w.cluster, 'nonprod', first])).toBe('EXG07')
    expect(await refused('exdb_worker', declare, [w.cluster, null, await declareOp()])).toBe(
      'EXG07',
    )
    expect(await refused('exdb_worker', declare, [w.cluster, 'staging', await declareOp()])).toBe(
      '23514',
    )
    expect(
      await refused('exdb_worker', declare, [w.cluster, 'nonprod', await declareOp()]),
    ).toBeUndefined()
    expect((await read())?.declared_tier).toBe('nonprod')
    // The time is the database's, never the writer's.
    expect(
      await refused(
        'exdb_worker',
        `UPDATE registry.clusters SET declared_tier_at = now() - interval '1 day' WHERE cluster_id = $1`,
        [w.cluster],
      ),
    ).toBe('EXG07')
  })

  it('accepts exactly the server providers of the contract', async () => {
    const o = await op()
    const insert = (provider: string) =>
      refused(
        'exdb_worker',
        `INSERT INTO registry.servers (server_id, display_name, provider, created_by_operation_id)
         VALUES ($1, 'db host', $2, $3)`,
        [newId('srv', now()), provider, o],
      )
    for (const provider of SERVER_PROVIDERS) {
      expect(await insert(provider), provider).toBeUndefined()
    }
    for (const provider of ['', 'hetzner', 'Hetzner_Cloud', 'linode', 'aws ', 'equinix_metal']) {
      expect(await insert(provider), provider).toBe('23514')
    }
    expect(
      await refused(
        'exdb_serve',
        `INSERT INTO registry.servers (server_id, display_name, provider, created_by_operation_id)
         VALUES ($1, 'db host', 'aws', $2)`,
        [newId('srv', now()), o],
      ),
    ).toBe('42501')
  })

  it('lets an address name one cluster only, registry-wide', async () => {
    const a = await world()
    const b = await world()
    const o = await op()
    const insert = (cluster: string) =>
      refused(
        'exdb_worker',
        `INSERT INTO registry.endpoints (endpoint_id, cluster_id, kind, host, port, tls_server_name, label, state, created_by_operation_id)
         VALUES ($1, $2, 'private', '10.9.9.9', 5432, 'pg.example.test', 'private', 'active', $3)`,
        [newId('end', now()), cluster, o],
      )
    expect(await insert(a.cluster)).toBeUndefined()
    expect(await insert(b.cluster)).toBe('23505')
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
        `INSERT INTO observation.schema_documents (fingerprint, canonicalizer, pg_major, entries, encoding, document,
                                                   content_bytes, document_digest)
         VALUES ($1, 'fp1', 17, 0, 'gzip', '\\x00', 1, $2) ON CONFLICT DO NOTHING`,
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
      expect(after.applied).toEqual([
        '01M48WRFNFYAY62E1146END05N',
        '01M48WRFNGYF5WH0884N169FNH',
        // Wave 5: the nodes bundle follows on the same upgrade, then the
        // gateway admission of the Wave 5 correction (F1).
        '01M49K5NQ8ZB4W2T6Y3H7RXJMD',
        '01M4DSPKRQD52Y8E9MKCYKWVFW',
        // Wave 6: the migration engine's records, break-glass grants, import reports, step-ups,
        // the worker's authority re-check, operator verification retries, migration baselines.
        '01M4QEE7JX03XAZJKZ2MRT8JJT',
        '01M4QN37EYQ6X0NFPAQRPK5FAG',
        '01M4QPP4T3E31ANKDVSR7T3YHS',
        '01M4QT02MQ05WZ8J29C134Y45A',
        '01M4R2T03VG6F43SEKX6F5ST5G',
        '01M4R53PV1XDVSGDSVN86DQ3JB',
        '01M4R66846BD63S51NS15EZKB1',
        // Wave 7: the MCP endpoint's installation keys (cursors, request state), the
        // last use of each grant.
        '01M4S5TDSB5ZXPJCBFKF8WRT5C',
        '01M4S8BT93YJBDEE0Y6ZQAEH1J',
        // and the data-read lane.
        '01M4SCEZ0HK44KYQHA1RQZFGCK',
        // After Wave 7: the audit filter indexes for client and grant.
        '01M4T4DMYR23DXVB3SP8RF3RBZ',
        // Owner decision 2026-10-13: open client registration (the guard of oauth.clients).
        '01M4TKQ5C3X8Y2NZ7D4B9W6F1H',
        // Wave 8: a drift acceptance stores its snapshot with its own purpose.
        '01M4V4DA2W7HK9QB5NZ3XT6RME',
        // Wave 8: saved queries and the index of one's own data reads in the audit.
        '01M4V1SQ7K2D9QHRZ5XW0BN3EA',
        // Wave 8 (OD-22, extended 2026-10-13): the declared tier of clusters, tiered registry.manage.
        '01M4V2CT4N8PJ6GZ3YQ1RWK7HD',
        // Owner decision S3 (2026-10-13): write-only storage of role verifiers.
        '01M4V3RV9F5XM2TB8KC6QZJ0NS',
        // Owner decision S10 (2026-10-13): the profile of a person (display name, picture).
        '01M4V7PRFXK2N9QB4ZH6WD3TME',
        // Owner decision of 2026-10-21: a longer list of server providers.
        '01M5F4NHFTMQRYJA43P8GKP44M',
        // Wave 9 Part A (A2, A3): evidence strength and drift totals of legacy imports.
        '01M5G6EQ7GKZV615Y680AHT52B',
        // Wave 9 Part A (A5, A4): execution roles per environment and declared exceptions.
        '01M5G6EQ7MFWM3TVK3YN5WRK8W',
        '01M5G6EQ7KP3PMPC7G3HJ7KH7R',
        // Wave 9 Part A, follow-up 3 (F1): the failing expectations of an import item.
        '01M5PZFYDPT065MDFHG5G3WSG1',
        // The UI/UX order of 2026-10-26 (§8A): servers and clusters retired bottom-up.
        '01M5WT5NV9ZC8TYB9BMP3D0EZZ',
        // Wave 9 Part B (2026-10-26): statement statistics, subject findings, the backup catalog.
        '01M5X840BFXMZ7Z6FF13AD56YJ',
        '01M5X840BJSCYX2JZ3HYCMHDBT',
        '01M5X840BK55NGFGQ5G3Z1C5NH',
        // OD-54 (a), Wave 9 Part B order (2026-10-26): an external cluster adopted by the node agent.
        '01M5X840BMQPER7PK6WH64NR2J',
        // OD-56 (a), Wave 9 Part B order (2026-10-26): keyed digests of excused values.
        '01M5X840BP8JXGEQGS0PHPTB58',
      ])
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
