import { createHash } from 'node:crypto'
import { newId } from '@exponetdb/kernel'
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ControlStoreRole } from '../src/index.ts'
import { type MigratedTestDatabase, migratedTestDatabase } from '../src/testing/index.ts'

/**
 * The Wave 5 `nodes` schema against PostgreSQL 17 (control-plane.md §2):
 * what the database refuses whatever a process sends. Grants are exercised,
 * never read.
 */
let db: MigratedTestDatabase

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_nodes')
})

afterAll(async () => {
  await db?.drop()
})

type Client = pg.Client
const now = () => Date.now()
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`
const cert = (n: number) => Buffer.alloc(128, n)

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
       VALUES ($1, 'node.test', 1, 'queued', 'not_started', 'pending', 'system', 'system')`,
      [id],
    ),
  )
  return id
}

async function secret(purpose: string, subject: string, consumer: string): Promise<string> {
  const id = newId('sec', now())
  await as('super', (c) =>
    c.query(
      `INSERT INTO secrets.secret_versions (secret_id, version, purpose, subject_id, consumer, created_by)
       VALUES ($1, 1, $2, $3, $4, 'test')`,
      [id, purpose, subject, consumer],
    ),
  )
  return id
}

async function server(): Promise<string> {
  const id = newId('srv', now())
  const o = await op()
  await as('exdb_worker', (c) =>
    c.query(
      `INSERT INTO registry.servers (server_id, display_name, provider, labels, created_by_operation_id)
       VALUES ($1, 'db host', 'other', '{}', $2)`,
      [id, o],
    ),
  )
  return id
}

const JOB_KEYS = JSON.stringify([{ keyId: 'jobkey_2026_10', fingerprint: sha('jobkey') }])

/** A token created by the worker and issued by serve; returns its id and redeem hash. */
async function issuedToken(serverId: string): Promise<{ token: string; redeem: string }> {
  const token = newId('ent', now())
  const o = await op()
  await as('exdb_worker', (c) =>
    c.query(
      `INSERT INTO nodes.enrollment_tokens (token_id, server_id, job_keys, state, reveal_by, reveal_until,
                                            created_by_operation_id)
       VALUES ($1, $2, $3, 'created', $4, clock_timestamp() + interval '30 minutes', $5)`,
      [token, serverId, JOB_KEYS, newId('idn', now()), o],
    ),
  )
  const bind = await secret('node.bind_key', token, 'worker')
  const redeem = sha(`redeem ${token}`)
  await as('exdb_serve', (c) =>
    c.query(
      `UPDATE nodes.enrollment_tokens SET state = 'issued', redeem_hash = $2, bind_secret_id = $3 WHERE token_id = $1`,
      [token, redeem, bind],
    ),
  )
  return { token, redeem }
}

const key = (n: number) => Buffer.alloc(32, n)

async function enroll(token: string, redeem: string, node: string, n: number) {
  return as('exdb_gateway', (c) =>
    c.query(
      `SELECT * FROM nodes.enroll($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp() + interval '72 hours', $9, '1.0.0')`,
      [
        node,
        token,
        redeem,
        key(n),
        key(n + 1),
        key(n + 2),
        'A'.repeat(43),
        cert(n),
        '{"hostname":"h"}',
      ],
    ),
  )
}

describe('nodes schema (control-plane.md §2)', () => {
  it('issues a token once, redeems it once, and keeps one live node per server', async () => {
    const srv = await server()
    const { token, redeem } = await issuedToken(srv)
    const row = await as('super', (c) =>
      c.query(
        `SELECT state, issued_at, expires_at - issued_at AS life FROM nodes.enrollment_tokens WHERE token_id = $1`,
        [token],
      ),
    )
    expect(row.rows[0]).toMatchObject({ state: 'issued' })
    expect(
      await refused(
        'exdb_serve',
        `UPDATE nodes.enrollment_tokens SET server_id = $2 WHERE token_id = $1`,
        [token, srv],
      ),
    ).toBe('42501')
    expect(
      await refused(
        'exdb_serve',
        `UPDATE nodes.enrollment_tokens SET redeem_hash = $2 WHERE token_id = $1`,
        [token, sha('other')],
      ),
    ).toBe('EXN03')

    const node = newId('nod', now())
    expect(
      await refused(
        'exdb_gateway',
        `SELECT * FROM nodes.enroll($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), '{}', '1.0.0')`,
        [node, token, sha('wrong'), key(1), key(2), key(3), 'A'.repeat(43), cert(1)],
      ),
    ).toBe('EXN07')
    const result = await enroll(token, redeem, node, 10)
    expect(result.rows[0]).toEqual({ server_id: srv, job_keys: JSON.parse(JOB_KEYS) })
    expect(
      await refused(
        'exdb_gateway',
        `SELECT * FROM nodes.enroll($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), '{}', '1.0.0')`,
        [newId('nod', now()), token, redeem, key(20), key(21), key(22), 'A'.repeat(43), cert(20)],
      ),
    ).toBe('EXN07')

    const second = await issuedToken(srv)
    expect(
      await refused(
        'exdb_gateway',
        `SELECT * FROM nodes.enroll($1, $2, $3, $4, $5, $6, $7, $8, clock_timestamp(), '{}', '1.0.0')`,
        [
          newId('nod', now()),
          second.token,
          second.redeem,
          key(30),
          key(31),
          key(32),
          'A'.repeat(43),
          cert(30),
        ],
      ),
    ).toBe('EXN08')

    // The gateway reads neither tokens nor bind proofs nor encryption keys, and writes no table.
    expect(await refused('exdb_gateway', `SELECT token_id FROM nodes.enrollment_tokens`)).toBe(
      '42501',
    )
    expect(await refused('exdb_gateway', `SELECT bind_proof FROM nodes.nodes`)).toBe('42501')
    expect(await refused('exdb_gateway', `SELECT node_encryption_key FROM nodes.nodes`)).toBe(
      '42501',
    )
    expect(
      await refused('exdb_gateway', `UPDATE nodes.nodes SET state = 'active' WHERE node_id = $1`, [
        node,
      ]),
    ).toBe('42501')
  })

  it('serves a node only with its current certificate, binds it, runs one job at a time and revokes it', async () => {
    const srv = await server()
    const { token, redeem } = await issuedToken(srv)
    const node = newId('nod', now())
    await enroll(token, redeem, node, 40)
    const gw = <T>(fn: (c: Client) => Promise<T>) => as('exdb_gateway', fn)

    // Pending binding: hello is served, jobs are not.
    await gw((c) =>
      c.query(`SELECT nodes.hello($1, $2, '{}', '1.0.0', 1, '[]', '[]')`, [node, cert(40)]),
    )
    expect(await refused('exdb_gateway', `SELECT nodes.claim($1, $2)`, [node, cert(40)])).toBe(
      'EXN06',
    )
    expect(
      await refused('exdb_gateway', `SELECT nodes.hello($1, $2, '{}', '1.0.0', 1, '[]', '[]')`, [
        node,
        cert(99),
      ]),
    ).toBe('EXN06')
    const o = await op()
    const envelope = (jobId: string, nonce: string) => ({
      jobId,
      nodeId: node,
      operationId: o,
      capability: { name: 'agent.diagnostics', major: 1 },
      args: {},
      argsHash: sha('{}'),
      nonce,
      signature: { alg: 'Ed25519', keyId: 'jobkey_2026_10', value: 'x' },
    })
    const job = newId('job', now())
    const insertJob = (id: string, nonce: string) =>
      refused(
        'exdb_worker',
        `INSERT INTO nodes.jobs (job_id, node_id, operation_id, capability, envelope, args_hash, nonce, not_before, expires_at, state)
         VALUES ($1, $2, $3, 'agent.diagnostics@1', $4, $5, $6, clock_timestamp(), clock_timestamp() + interval '15 minutes', 'pending')`,
        [id, node, o, JSON.stringify(envelope(id, nonce)), sha('{}'), nonce],
      )
    expect(await insertJob(job, 'AAECAwQFBgcICQoLDA0ODw')).toBe('EXN05')

    // Binding: the worker activates the node; the bind proof goes.
    expect(
      await refused('exdb_worker', `UPDATE nodes.nodes SET state = 'active' WHERE node_id = $1`, [
        node,
      ]),
    ).toBeUndefined()
    const bound = await as('super', (c) =>
      c.query(`SELECT bound_at, bind_proof FROM nodes.nodes WHERE node_id = $1`, [node]),
    )
    expect(bound.rows[0].bind_proof).toBeNull()
    expect(bound.rows[0].bound_at).not.toBeNull()

    expect(await insertJob(job, 'AAECAwQFBgcICQoLDA0ODw')).toBeUndefined()
    const job2 = newId('job', now() + 1)
    expect(await insertJob(job2, 'AQECAwQFBgcICQoLDA0ODw')).toBeUndefined()
    expect(
      await refused('exdb_worker', `UPDATE nodes.jobs SET envelope = '{}' WHERE job_id = $1`, [
        job,
      ]),
    ).toBe('42501')
    expect(
      await refused(
        'super',
        `UPDATE nodes.jobs SET envelope = envelope || '{"attempt":2}' WHERE job_id = $1`,
        [job],
      ),
    ).toBe('EXN05')

    const claim = () => gw((c) => c.query(`SELECT nodes.claim($1, $2) AS job`, [node, cert(40)]))
    expect((await claim()).rows[0].job.jobId).toBe(job)
    expect((await claim()).rows[0].job).toBeNull() // one job at a time
    // Not started within 60 s: the identical envelope again.
    await as('super', (c) =>
      c.query(
        `UPDATE nodes.jobs SET dispatched_at = dispatched_at - interval '61 seconds' WHERE job_id = $1`,
        [job],
      ),
    )
    const again = (await claim()).rows[0].job
    expect(again).toEqual(envelope(job, 'AAECAwQFBgcICQoLDA0ODw'))

    await gw((c) => c.query(`SELECT nodes.start($1, $2, $3)`, [node, cert(40), job]))
    expect(
      await refused('exdb_gateway', `SELECT nodes.start($1, $2, $3)`, [node, cert(40), job]),
    ).toBe('EXN09')
    const progress = await gw((c) =>
      c.query(`SELECT * FROM nodes.progress($1, $2, $3, '[]')`, [node, cert(40), job]),
    )
    expect(progress.rows[0].cancel_requested).toBe(false)
    const completion = { jobId: job, nodeId: node, outcome: 'succeeded' }
    const complete = (id: string, body: object) =>
      gw((c) =>
        c.query(`SELECT nodes.complete($1, $2, $3, $4) AS r`, [
          node,
          cert(40),
          id,
          JSON.stringify(body),
        ]),
      )
    expect((await complete(job, completion)).rows[0].r).toBe('accepted')
    expect((await complete(job, completion)).rows[0].r).toBe('duplicate')
    expect(
      await refused('exdb_gateway', `SELECT nodes.complete($1, $2, $3, $4)`, [
        node,
        cert(40),
        job2,
        JSON.stringify(completion),
      ]),
    ).toBe('EXN09')

    // A running job whose lease ran out has an unknown outcome; a late result still lands.
    expect((await claim()).rows[0].job.jobId).toBe(job2)
    await gw((c) => c.query(`SELECT nodes.start($1, $2, $3)`, [node, cert(40), job2]))
    await as('super', (c) =>
      c.query(
        `UPDATE nodes.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE job_id = $1`,
        [job2],
      ),
    )
    await as('exdb_worker', (c) => c.query(`SELECT nodes.sweep_jobs()`))
    const swept = await as('super', (c) =>
      c.query(`SELECT state FROM nodes.jobs WHERE job_id = $1`, [job2]),
    )
    expect(swept.rows[0].state).toBe('outcome_unknown')
    expect((await complete(job2, { jobId: job2, nodeId: node, outcome: 'failed' })).rows[0].r).toBe(
      'accepted',
    )

    // The worker's verdict is recorded once.
    expect(
      await refused(
        'exdb_worker',
        `UPDATE nodes.jobs SET node_signature_valid = true, judged_at = clock_timestamp() WHERE job_id = $1`,
        [job],
      ),
    ).toBeUndefined()
    expect(
      await refused(
        'exdb_worker',
        `UPDATE nodes.jobs SET node_signature_valid = false WHERE job_id = $1`,
        [job],
      ),
    ).toBe('EXN05')

    // Revocation names its operation; a revoked node is refused at its next request.
    expect(
      await refused('exdb_worker', `UPDATE nodes.nodes SET state = 'revoked' WHERE node_id = $1`, [
        node,
      ]),
    ).toBe('EXN04')
    const revoke = await op()
    expect(
      await refused(
        'exdb_worker',
        `UPDATE nodes.nodes SET state = 'revoked', state_changed_by_operation_id = $2, state_reason = 'test' WHERE node_id = $1`,
        [node, revoke],
      ),
    ).toBeUndefined()
    expect(
      await refused('exdb_gateway', `SELECT nodes.heartbeat($1, $2, '{}')`, [node, cert(40)]),
    ).toBe('EXN06')
    expect(
      await refused('exdb_worker', `UPDATE nodes.nodes SET state = 'active' WHERE node_id = $1`, [
        node,
      ]),
    ).toBe('EXN04')
  })

  it('records the agent PKI once and only with gateway-consumer keys; job keys are worker secrets', async () => {
    const worker = await secret('node.pki', 'issuing', 'worker')
    const g1 = await secret('node.pki', 'issuing', 'gateway')
    const g2 = await secret('node.pki', 'server', 'gateway')
    const g3 = await secret('node.pki', 'gateway', 'gateway')
    const insert = (a: string) =>
      refused(
        'exdb_worker',
        `INSERT INTO nodes.pki (root_certificate, root_fingerprint, issuing_ca_certificate, issuing_ca_key_secret_id,
                                server_ca_certificate, server_ca_key_secret_id, gateway_certificate, gateway_key_secret_id,
                                gateway_url, gateway_server_name)
         VALUES ($1, $2, $1, $3, $1, $4, $1, $5, 'https://10.8.2.2:7443', 'gateway.exdb.internal')`,
        [cert(1), sha('root'), a, g2, g3],
      )
    expect(await insert(worker)).toBe('EXN01')
    expect(await insert(g1)).toBeUndefined()
    expect(await insert(g1)).toBe('23505')
    expect(
      await refused(
        'exdb_worker',
        `UPDATE nodes.pki SET gateway_url = 'https://evil.example:7443'`,
      ),
    ).toBe('42501')

    const pub = key(77)
    const fingerprint = `sha256:${createHash('sha256').update(pub).digest('hex')}`
    const gatewaySecret = await secret('node.job_key', 'jobkey_x', 'gateway')
    const workerSecret = await secret('node.job_key', 'jobkey_x', 'worker')
    const addKey = (sec: string, fp: string) =>
      refused(
        'exdb_worker',
        `INSERT INTO nodes.job_keys (key_id, public_key, fingerprint, secret_id, state) VALUES ('jobkey_x', $1, $2, $3, 'active')`,
        [pub, fp, sec],
      )
    expect(await addKey(gatewaySecret, fingerprint)).toBe('EXN02')
    expect(await addKey(workerSecret, sha('other'))).toBe('EXN02')
    expect(await addKey(workerSecret, fingerprint)).toBeUndefined()
    expect(await refused('exdb_gateway', `SELECT secret_id FROM nodes.job_keys`)).toBe('42501')
  })
})
