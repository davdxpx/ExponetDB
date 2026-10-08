import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyAuditChain } from '@exponetdb/audit'
import { RETIRED_NODE_CAPABILITIES } from '@exponetdb/contracts'
import { loadBundleSet, migrateControlStore } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { newId, systemClock } from '@exponetdb/kernel'
import { initPki } from '@exponetdb/nodes'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registryWorld, simulatedNode, storeOf } from './support/node-world.ts'

/**
 * OD-28 option (b), proven on a fixture (node-runbook.md §10): the owner-run
 * scrub of what a retired capability major stored before the Wave 5
 * correction F1. Rows as the earlier release left them (a completion, its
 * observation and signed arguments holding a canary, an open job, an expired
 * plan whose analysis holds the canary) are seeded into a migrated store;
 * the census counts them, the scrub refuses while a job is open, then
 * replaces each value by its provenance marker. Afterwards no table of the
 * store holds the canary, current-major rows and the audit chain are as
 * they were, every bundle still verifies, the guards are back on, and a
 * second run changes nothing. Real PostgreSQL; nothing here runs on a real
 * installation.
 */

const DIR = join(import.meta.dirname, '..', '..', '..', 'packages', 'nodes', 'maintenance', 'od28')
const CENSUS = readFileSync(join(DIR, 'census.sql'), 'utf8')
const SCRUB = readFileSync(join(DIR, 'scrub.sql'), 'utf8')
const CANARY = 'exdb-canary-od28-5c2e71'

let db: MigratedTestDatabase
let keyring: Keyring

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_od28')
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
}, 120_000)

afterAll(async () => {
  await db?.drop()
})

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

async function census(): Promise<Record<string, number>> {
  const { rows } = await db.asRole('exdb_migrate', (c) => c.query(CENSUS))
  return Object.fromEntries(rows.map((r) => [r.stored as string, r.rows as number]))
}

async function scrub(): Promise<string> {
  return db.asRole('exdb_migrate', async (c) => {
    try {
      await c.query(SCRUB)
      return 'done'
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined)
      return error instanceof Error ? error.message : String(error)
    }
  })
}

/** Every row of every table of the store that holds the canary, by table. */
async function canaryRows(): Promise<Record<string, number>> {
  return db.asSuperuser(async (c) => {
    const { rows: tables } = await c.query(
      `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
    )
    const found: Record<string, number> = {}
    for (const { t } of tables) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE '%' || $1 || '%'`,
        [CANARY],
      )
      if (rows[0].n > 0) found[t] = rows[0].n
    }
    return found
  })
}

async function tableDigest(): Promise<string> {
  const { rows } = await db.asSuperuser((c) =>
    c.query(
      `SELECT md5(coalesce((SELECT string_agg(j::text, '|' ORDER BY job_id) FROM nodes.jobs j), '')
                  || coalesce((SELECT string_agg(o::text, '|' ORDER BY job_id) FROM nodes.observations o), '')
                  || coalesce((SELECT string_agg(b::text, '|' ORDER BY plan_id) FROM operations.plan_bodies b), '')) AS d`,
    ),
  )
  return rows[0].d as string
}

describe('OD-28 remediation procedure (fixture)', () => {
  it('lists the retired majors exactly as the contract does', () => {
    const listed = (sql: string) =>
      [...sql.matchAll(/'([a-z][a-z0-9_.]*@[0-9]+)'/g)].map((m) => m[1]).sort()
    const contract = Object.keys(RETIRED_NODE_CAPABILITIES).sort()
    expect(listed(CENSUS)).toEqual(contract)
    expect(listed(SCRUB)).toEqual(contract)
  })

  it('scrubs what a retired major stored, keeps everything else, and runs once', async () => {
    const w = await registryWorld(db)
    const node = await simulatedNode(db, keyring, w, () => ({}))
    const operationId = newId('op', Date.now())
    const job = (n: number) => newId('job', Date.now() + n)
    const [inspected, applied, open, current] = [job(1), job(2), job(3), job(4)]
    const [legacyPlan, currentPlan, rotationPlan] = [
      newId('pln', Date.now() + 5),
      newId('pln', Date.now() + 6),
      newId('pln', Date.now() + 7),
    ]
    const legacyBody = JSON.stringify({
      analysis: {
        parameters: [{ current: `host=10.0.0.9 password=${CANARY}`, name: 'primary_conninfo' }],
      },
      content: { basis: { capability: 'postgres.config.plan@1', digest: null, jobId: inspected } },
    })
    const appliedArgs = { parameters: [{ name: 'primary_conninfo', value: `password=${CANARY}` }] }
    // A rotation bound to a retired major holds ids and a role name only;
    // the worker still reads it to decide its credential (review finding).
    const rotationBody = JSON.stringify({
      analysis: { role: 'verifier' },
      content: {
        basis: { capability: 'postgres.roles.inspect@1', digest: null, jobId: inspected },
      },
      expectedState: { activeCredentialId: null },
    })
    const currentBody = JSON.stringify({
      analysis: { tier: 'nonprod' },
      content: { basis: { capability: 'postgres.config.plan@2', digest: null, jobId: current } },
    })
    // As the earlier release left them (the guards would refuse a raw insert).
    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(
        `INSERT INTO operations.operations (operation_id, kind, kind_version, state, apply_outcome, verification_outcome,
                                            actor_kind, client_kind)
         VALUES ($1, 'node.inspect', 1, 'succeeded', 'applied', 'passed', 'system', 'system')`,
        [operationId],
      )
      const insertJob = (
        id: string,
        capability: string,
        state: string,
        args: object,
        completion: object | null,
      ) =>
        c.query(
          `INSERT INTO nodes.jobs (job_id, node_id, operation_id, capability, envelope, args_hash, nonce, not_before,
                                   expires_at, state, run_seconds, completion, outcome, completed_at,
                                   node_signature_valid, judged_at, created_at, state_changed_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now() - interval '2 hours', now() - interval '90 minutes', $8, 60,
                   $9::jsonb, $10, CASE WHEN $9::jsonb IS NULL THEN NULL ELSE now() END,
                   CASE WHEN $9::jsonb IS NULL THEN NULL ELSE true END, CASE WHEN $9::jsonb IS NULL THEN NULL ELSE now() END,
                   now() - interval '2 hours', now())`,
          [
            id,
            node.nodeId,
            operationId,
            capability,
            JSON.stringify({ jobId: id, nodeId: node.nodeId, capability, args }),
            `sha256:${sha(JSON.stringify(args))}`,
            id.slice(4, 26).replace(/[^A-Za-z0-9]/g, 'A'),
            state,
            completion === null ? null : JSON.stringify(completion),
            completion === null ? null : 'succeeded',
          ],
        )
      await insertJob(
        inspected,
        'postgres.config.inspect@1',
        'completed',
        { cluster: { localName: '17/main' } },
        {
          jobId: inspected,
          outcome: 'succeeded',
          result: { settings: [{ name: 'primary_conninfo', setting: `password=${CANARY}` }] },
        },
      )
      await insertJob(applied, 'postgres.config.apply@1', 'outcome_unknown', appliedArgs, null)
      await insertJob(open, 'agent.diagnostics@1', 'dispatched', {}, null)
      await insertJob(
        current,
        'postgres.status@1',
        'completed',
        {},
        { jobId: current, outcome: 'succeeded', result: { running: true, note: 'keep-me' } },
      )
      for (const [id, capability, result] of [
        [inspected, 'postgres.config.inspect@1', { settings: [{ setting: `password=${CANARY}` }] }],
        [current, 'postgres.status@1', { running: true, note: 'keep-me' }],
      ] as const) {
        await c.query(
          `INSERT INTO nodes.observations (job_id, node_id, capability, args_hash, operation_id, result, observed_at)
           SELECT job_id, node_id, capability, args_hash, operation_id, $2::jsonb, now() FROM nodes.jobs
            WHERE job_id = $1 AND capability = $3`,
          [id, JSON.stringify(result), capability],
        )
      }
      for (const [id, body, kind] of [
        [legacyPlan, legacyBody, 'postgres.config.apply'],
        [currentPlan, currentBody, 'postgres.config.apply'],
        [rotationPlan, rotationBody, 'credential.rotate'],
      ] as const) {
        await c.query(
          `INSERT INTO operations.plans (plan_id, kind, kind_version, action_class, state, decision, plan_hash,
                                         content_checksum, policy_version, actor_kind, client_kind, tier,
                                         created_at, expires_at)
           VALUES ($1, $4, 1, 'high', 'expired', 'allow', $2, $2, $3, 'system', 'system',
                   'nonprod', now() - interval '3 hours', now() - interval '2 hours')`,
          [id, `sha256:${sha(body)}`, `sha256:pv1:${'0'.repeat(64)}`, kind],
        )
        await c.query('INSERT INTO operations.plan_bodies (plan_id, body) VALUES ($1, $2)', [
          id,
          body,
        ])
      }
      await c.query('COMMIT')
    })
    const before = await db.asSuperuser((c) =>
      c.query(
        `SELECT (SELECT encode(sha256(convert_to(completion::text, 'UTF8')), 'hex') FROM nodes.jobs WHERE job_id = $1) AS completion,
                (SELECT encode(sha256(convert_to((envelope -> 'args')::text, 'UTF8')), 'hex') FROM nodes.jobs WHERE job_id = $2) AS args,
                (SELECT encode(sha256(convert_to(result::text, 'UTF8')), 'hex') FROM nodes.observations WHERE job_id = $1) AS result,
                (SELECT count(*)::int FROM audit.audit_events) AS audit`,
        [inspected, applied],
      ),
    )
    const hashes = before.rows[0]
    expect(Object.keys(await canaryRows()).sort()).toEqual([
      'nodes.jobs',
      'nodes.observations',
      'operations.plan_bodies',
    ])

    expect(await census()).toEqual({
      'nodes.jobs.completion': 1,
      'nodes.jobs.envelope.args': 3,
      'nodes.observations.result': 1,
      'operations.plan_bodies.body': 1,
      'nodes.jobs open (scrub refuses while > 0)': 1,
    })
    // An open job of a retired major: refused, nothing changed.
    const digest = await tableDigest()
    expect(await scrub()).toContain('od28: a job of a retired major is still open')
    expect(await tableDigest()).toBe(digest)

    await db.asSuperuser(async (c) => {
      await c.query('BEGIN')
      await c.query('SET LOCAL session_replication_role = replica')
      await c.query(`UPDATE nodes.jobs SET state = 'outcome_unknown' WHERE job_id = $1`, [open])
      await c.query('COMMIT')
    })
    expect(await scrub()).toBe('done')

    // Nothing of the canary is left anywhere in the store.
    expect(await canaryRows()).toEqual({})
    const marker = (hex: string) => ({ exdbScrubbed: { procedure: 'od28/v1', sha256: hex } })
    const after = await db.asSuperuser((c) =>
      c.query(
        `SELECT j.job_id, j.state, j.args_hash, j.node_signature_valid AS valid, j.completion,
                j.envelope -> 'args' AS args, j.envelope ->> 'capability' AS capability, o.result
           FROM nodes.jobs j LEFT JOIN nodes.observations o USING (job_id)
          WHERE j.job_id = ANY($1) ORDER BY j.job_id`,
        [[inspected, applied, current]],
      ),
    )
    const row = (id: string) => after.rows.find((r) => r.job_id === id)
    expect(row(inspected)).toMatchObject({
      state: 'completed',
      valid: true,
      capability: 'postgres.config.inspect@1',
      completion: marker(hashes.completion),
      result: marker(hashes.result),
    })
    expect(row(applied)).toMatchObject({ state: 'outcome_unknown', args: marker(hashes.args) })
    // The args hash still names the original arguments.
    expect(row(applied)?.args_hash).toBe(`sha256:${sha(JSON.stringify(appliedArgs))}`)
    // A current major's rows and a plan of a current basis are untouched.
    expect(row(current)).toMatchObject({
      completion: { result: { note: 'keep-me' } },
      result: { note: 'keep-me' },
    })
    const bodies = await db.asSuperuser((c) =>
      c.query(
        `SELECT b.plan_id, b.body, p.plan_hash FROM operations.plan_bodies b JOIN operations.plans p USING (plan_id)
          WHERE b.plan_id = ANY($1)`,
        [[legacyPlan, currentPlan, rotationPlan]],
      ),
    )
    const body = (id: string) => bodies.rows.find((r) => r.plan_id === id)
    expect(JSON.parse(body(legacyPlan)?.body)).toEqual(marker(sha(legacyBody)))
    expect(`sha256:${sha(legacyBody)}`).toBe(body(legacyPlan)?.plan_hash)
    expect(body(currentPlan)?.body).toBe(currentBody)
    expect(body(rotationPlan)?.body).toBe(rotationBody)

    // The guards are back on: a stored completion still never changes.
    const triggers = await db.asSuperuser((c) =>
      c.query(
        `SELECT count(*)::int AS off FROM pg_trigger
          WHERE tgrelid IN ('nodes.jobs'::regclass, 'nodes.observations'::regclass, 'operations.plan_bodies'::regclass)
            AND NOT tgisinternal AND tgenabled <> 'O'`,
      ),
    )
    expect(triggers.rows[0].off).toBe(0)
    await expect(
      db.asSuperuser((c) =>
        c.query(`UPDATE nodes.jobs SET completion = '{"x": 1}' WHERE job_id = $1`, [current]),
      ),
    ).rejects.toThrow()
    await expect(
      db.asSuperuser((c) =>
        c.query(`UPDATE operations.plan_bodies SET body = '{}' WHERE plan_id = $1`, [currentPlan]),
      ),
    ).rejects.toThrow()

    // The audit chain is as it was and verifies; every bundle still verifies.
    const audit = await db.asSuperuser((c) =>
      c.query('SELECT count(*)::int AS n FROM audit.audit_events'),
    )
    expect(audit.rows[0].n).toBe(hashes.audit)
    expect(await verifyAuditChain(storeOf(db, 'exdb_serve'))).toMatchObject({ ok: true })
    const again = await migrateControlStore({
      store: db.store('exdb_migrate', { poolMax: 1 }),
      bundles: await loadBundleSet(),
      engineVersion: 'test',
      newInstallationId: () => newId('ins', Date.now()),
    })
    expect(again.applied).toEqual([])
    expect(again.state.status).toBe('current')
    const migrations = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'packages',
      'control-store',
      'migrations',
    )
    for (const bundle of (await loadBundleSet()).bundles) {
      const checks = readFileSync(
        join(migrations, `${bundle.id}_${bundle.name}`, 'verify.sql'),
        'utf8',
      )
      const results = await db.asRole('exdb_migrate', (c) => c.query(checks))
      const rows = (Array.isArray(results) ? results : [results]).flatMap((r) => r.rows)
      expect(rows.length, bundle.name).toBeGreaterThan(0)
      expect(
        rows.every((r) => r.ok === true),
        bundle.name,
      ).toBe(true)
    }

    // Once: the census is empty and a second run changes nothing.
    expect(await census()).toEqual({
      'nodes.jobs.completion': 0,
      'nodes.jobs.envelope.args': 0,
      'nodes.observations.result': 0,
      'operations.plan_bodies.body': 0,
      'nodes.jobs open (scrub refuses while > 0)': 0,
    })
    const settled = await tableDigest()
    expect(await scrub()).toBe('done')
    expect(await tableDigest()).toBe(settled)
  })
})
