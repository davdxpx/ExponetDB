import type { ControlStore, ControlStoreRole } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { expectOk, parseId, type SecretId, systemClock } from '@exponetdb/kernel'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addSecretVersion,
  type Consumer,
  createSecret,
  type Keyring,
  keyringStatus,
  parseKeyring,
  readSecret,
  registerActiveKey,
  rewrapBatch,
  SecretError,
} from '../src/index.ts'

/**
 * Secrets against PostgreSQL 17: per-consumer ciphertext tables enforced by
 * real grants (every forbidden access is attempted), append-only rows,
 * substitution of rows, master key rotation with re-wrap, and a scan of the
 * whole Control Store for key material and plaintext.
 */
let db: MigratedTestDatabase
const stores = new Map<ControlStoreRole, ControlStore>()
const as = (role: ControlStoreRole): ControlStore => {
  let store = stores.get(role)
  if (store === undefined) {
    store = db.store(role)
    stores.set(role, store)
  }
  return store
}

const keyBytes = (n: number) => Buffer.alloc(32, n)
function keyring(...entries: { keyId: string; n: number }[]): Keyring {
  return expectOk(
    parseKeyring(
      JSON.stringify({
        format: 'exponetdb.keyring/v1',
        keys: entries.map((e, i) => ({
          keyId: e.keyId,
          status: i === 0 ? 'active' : 'decrypt_only',
          key: keyBytes(e.n).toString('base64'),
        })),
      }),
    ),
    'test keyring',
  )
}
const K1 = keyring({ keyId: 'k1', n: 0x11 })

async function sqlstate(
  role: ControlStoreRole,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  try {
    await as(role).query('test.statement', sql, params)
    return undefined
  } catch (error) {
    let current: unknown = error
    while (typeof current === 'object' && current !== null) {
      const code: unknown = Reflect.get(current, 'sqlstate')
      if (typeof code === 'string') {
        return code
      }
      current = Reflect.get(current, 'cause')
    }
    return 'unknown'
  }
}

const create = (
  role: ControlStoreRole,
  consumer: Consumer,
  value: string,
  ring = K1,
  subjectId = 'installation',
) =>
  as(role).transaction('test.secret.create', (tx) =>
    createSecret(
      tx,
      ring,
      { purpose: `test.${consumer}`, subjectId, consumer, plaintext: Buffer.from(value) },
      { clock: systemClock },
    ),
  )

const PLAINTEXTS: string[] = []
const remember = (value: string) => {
  PLAINTEXTS.push(value)
  return value
}

beforeAll(async () => {
  db = await migratedTestDatabase('exdb_it_secrets')
})

afterAll(async () => {
  await db?.drop()
})

describe('consumer separation (secrets.md §4)', () => {
  const readers: Record<Consumer, ControlStoreRole[]> = {
    worker: ['exdb_worker'],
    observer: ['exdb_worker', 'exdb_serve'],
    auth: ['exdb_serve'],
    gateway: ['exdb_gateway'],
  }
  const writers: Record<Consumer, ControlStoreRole[]> = {
    worker: ['exdb_worker', 'exdb_serve'],
    observer: ['exdb_worker', 'exdb_serve'],
    auth: ['exdb_serve'],
    gateway: ['exdb_worker'],
  }
  const RUNTIME: ControlStoreRole[] = [
    'exdb_serve',
    'exdb_worker',
    'exdb_gateway',
    'exdb_audit_maint',
  ]

  it('each consumer reads its own ciphertext; every other login is refused by PostgreSQL', async () => {
    for (const consumer of ['worker', 'observer', 'auth', 'gateway'] as const) {
      const writer = writers[consumer][0] ?? 'exdb_worker'
      const value = remember(`value for ${consumer} ${Math.random()}`)
      const ref = await create(writer, consumer, value)
      for (const role of RUNTIME) {
        const table = `secrets.secret_blobs_${consumer}`
        const code = await sqlstate(role, `SELECT ciphertext FROM ${table} LIMIT 1`)
        if (readers[consumer].includes(role)) {
          expect(code, `${role} reads ${table}`).toBeUndefined()
          const plain = await readSecret(as(role), K1, { secretId: ref.secretId, consumer })
          expect(plain.toString()).toBe(value)
        } else {
          expect(code, `${role} must not read ${table}`).toBe('42501')
          await expect(
            readSecret(as(role), K1, { secretId: ref.secretId, consumer }),
          ).rejects.toMatchObject({
            code: 'secret_store_failed',
          })
        }
      }
    }
  })

  it('only the documented writers may insert ciphertext (write-only where they cannot read)', async () => {
    for (const consumer of ['worker', 'observer', 'auth', 'gateway'] as const) {
      for (const role of RUNTIME) {
        const code = await sqlstate(
          role,
          `INSERT INTO secrets.secret_blobs_${consumer} (secret_id, version, nonce, ciphertext)
           VALUES ('sec_01JB2Z6G8M4Q7R9T1V3W5X7Y9Z', 1, '\\x00', '\\x00')`,
        )
        if (writers[consumer].includes(role)) {
          expect(code, `${role} may insert into ${consumer}`).not.toBe('42501')
        } else {
          expect(code, `${role} must not insert into ${consumer}`).toBe('42501')
        }
      }
    }
  })

  it('serve submits a worker secret it can never read back', async () => {
    const value = remember('submitted once by serve')
    const ref = await create('exdb_serve', 'worker', value)
    await expect(
      readSecret(as('exdb_serve'), K1, { secretId: ref.secretId, consumer: 'worker' }),
    ).rejects.toBeInstanceOf(SecretError)
    expect(
      (
        await readSecret(as('exdb_worker'), K1, { secretId: ref.secretId, consumer: 'worker' })
      ).toString(),
    ).toBe(value)
  })

  it('the audit maintenance login cannot even see the schema', async () => {
    for (const table of ['master_keys', 'secret_versions', 'data_keys', 'secret_blobs_worker']) {
      expect(await sqlstate('exdb_audit_maint', `SELECT 1 FROM secrets.${table} LIMIT 1`)).toBe(
        '42501',
      )
    }
  })

  it('a row cannot be written into another consumer’s table', async () => {
    const observed = await as('exdb_serve').transaction(
      'test.secret.wrong_consumer',
      async (tx) => {
        await tx.query(
          'test.secret.version',
          `INSERT INTO secrets.secret_versions (secret_id, version, purpose, subject_id, consumer, created_by)
           VALUES ('sec_01JB2Z6G8M4Q7R9T1V3W5X7YB0', 1, 'test.auth', 'installation', 'auth', 'x')`,
        )
        const refused = await tx
          .savepoint((sp) =>
            sp.query(
              'test.secret.blob',
              `INSERT INTO secrets.secret_blobs_observer (secret_id, version, nonce, ciphertext)
               VALUES ('sec_01JB2Z6G8M4Q7R9T1V3W5X7YB0', 1, '\\x000000000000000000000000', '\\x0000000000000000000000000000000000')`,
            ),
          )
          .then(
            () => 'inserted',
            (e: unknown) =>
              typeof e === 'object' && e !== null ? String(Reflect.get(e, 'sqlstate')) : 'unknown',
          )
        const who = await tx.query(
          'test.secret.created_by',
          "SELECT created_by FROM secrets.secret_versions WHERE secret_id = 'sec_01JB2Z6G8M4Q7R9T1V3W5X7YB0'",
        )
        return { refused, createdBy: who.rows[0]?.text('created_by') }
      },
      { rollbackOnly: true },
    )
    expect(observed).toEqual({ refused: 'EXS02', createdBy: 'exdb_serve' })
  })
})

describe('append-only rows', () => {
  it('no runtime login can update, delete or truncate; the owner is refused by trigger', async () => {
    await create('exdb_worker', 'worker', remember('row for immutability'))
    const tables = [
      'master_keys',
      'secret_versions',
      'secret_blobs_worker',
      'secret_blobs_observer',
      'secret_blobs_auth',
      'secret_blobs_gateway',
    ]
    for (const role of ['exdb_serve', 'exdb_worker', 'exdb_gateway'] as const) {
      for (const table of tables) {
        expect(await sqlstate(role, `DELETE FROM secrets.${table}`), `${role} ${table}`).toBe(
          '42501',
        )
        expect(await sqlstate(role, `TRUNCATE secrets.${table}`), `${role} ${table}`).toBe('42501')
      }
      expect(await sqlstate(role, "UPDATE secrets.secret_versions SET purpose = 'x'")).toBe('42501')
      expect(await sqlstate(role, 'DELETE FROM secrets.data_keys')).toBe('42501')
    }
    expect(await sqlstate('exdb_serve', "UPDATE secrets.data_keys SET key_id = 'k1'")).toBe('42501')
    expect(await sqlstate('exdb_worker', "UPDATE secrets.data_keys SET secret_id = 'x'")).toBe(
      '42501',
    )
    for (const sql of [
      "UPDATE secrets.secret_versions SET purpose = 'x'",
      'DELETE FROM secrets.secret_blobs_worker',
      'DELETE FROM secrets.data_keys',
      "UPDATE secrets.master_keys SET check_value = 'x'",
      'TRUNCATE secrets.secret_blobs_worker',
    ]) {
      expect(await sqlstate('exdb_migrate', sql), sql).toBe('EXA01')
    }
  })

  it('versions follow each other and keep their context', async () => {
    const ref = await create('exdb_worker', 'worker', remember('version one'))
    const v2 = await as('exdb_worker').transaction('test.secret.v2', (tx) =>
      addSecretVersion(tx, K1, ref.secretId, Buffer.from(remember('version two'))),
    )
    expect(v2.version).toBe(2)
    const worker = as('exdb_worker')
    expect(
      (await readSecret(worker, K1, { secretId: ref.secretId, consumer: 'worker' })).toString(),
    ).toBe('version two')
    expect(
      (
        await readSecret(worker, K1, { secretId: ref.secretId, consumer: 'worker', version: 1 })
      ).toString(),
    ).toBe('version one')
    for (const [version, purpose] of [
      [4, 'test.worker'],
      [3, 'test.other'],
    ] as const) {
      expect(
        await sqlstate(
          'exdb_worker',
          `INSERT INTO secrets.secret_versions (secret_id, version, purpose, subject_id, consumer, created_by)
           VALUES ($1, $2, $3, 'installation', 'worker', 'x')`,
          [ref.secretId, version, purpose],
        ),
      ).toBe('EXS01')
    }
  })
})

describe('substitution in the database', () => {
  it('ciphertext or a data key copied to another row fails to decrypt', async () => {
    const a = await create('exdb_worker', 'worker', remember('secret A'))
    const b = await create('exdb_worker', 'worker', remember('secret B'))
    const copy = async (sql: string) =>
      db.asSuperuser(async (c) => {
        await c.query('BEGIN')
        await c.query("SET LOCAL session_replication_role = 'replica'")
        await c.query(sql, [a.secretId, b.secretId])
        await c.query('COMMIT')
      })
    await copy(
      `UPDATE secrets.secret_blobs_worker t SET nonce = s.nonce, ciphertext = s.ciphertext
         FROM secrets.secret_blobs_worker s WHERE s.secret_id = $1 AND t.secret_id = $2`,
    )
    await expect(
      readSecret(as('exdb_worker'), K1, { secretId: b.secretId, consumer: 'worker' }),
    ).rejects.toMatchObject({
      code: 'secret_decrypt_failed',
    })
    await copy(
      `UPDATE secrets.data_keys t SET wrap_nonce = s.wrap_nonce, wrapped_key = s.wrapped_key
         FROM secrets.data_keys s WHERE s.secret_id = $1 AND t.secret_id = $2`,
    )
    // Both halves of A now sit in B's rows: still bound to A's context.
    await expect(
      readSecret(as('exdb_worker'), K1, { secretId: b.secretId, consumer: 'worker' }),
    ).rejects.toMatchObject({
      code: 'secret_decrypt_failed',
    })
    expect(
      (
        await readSecret(as('exdb_worker'), K1, { secretId: a.secretId, consumer: 'worker' })
      ).toString(),
    ).toBe('secret A')
  })
})

describe('master key rotation (secrets.md §3)', () => {
  const K2 = keyring({ keyId: 'k2', n: 0x22 }, { keyId: 'k1', n: 0x11 })
  const K2_ONLY = keyring({ keyId: 'k2', n: 0x22 })

  it('refuses a keyring whose key differs from the one registered under its id', async () => {
    const impostor = keyring({ keyId: 'k1', n: 0x99 })
    await expect(
      as('exdb_worker').transaction('test.secret.impostor', (tx) =>
        registerActiveKey(tx, impostor),
      ),
    ).rejects.toMatchObject({
      code: 'secret_key_mismatch',
      keyId: 'k1',
    })
    expect((await keyringStatus(as('exdb_serve'), impostor)).mismatched).toEqual(['k1'])
  })

  it('re-wraps every data key under the new key; then the old key is unreferenced and removable', async () => {
    const before = await keyringStatus(as('exdb_worker'), K2)
    const referencedByK1 = before.references.get('k1') ?? 0
    expect(referencedByK1).toBeGreaterThan(5)
    expect(before.removable).toEqual([])
    expect((await keyringStatus(as('exdb_worker'), K2_ONLY)).missing).toEqual(['k1'])

    // Two workers re-wrap concurrently in small batches; SKIP LOCKED splits
    // the rows. The row damaged by the substitution test cannot be unwrapped:
    // it is reported and stays on k1.
    const run = async () => {
      let total = 0
      const unreadable = new Set<string>()
      let after: { secretId: SecretId; version: number } | undefined
      for (;;) {
        const batch = await as('exdb_worker').transaction('test.secret.rewrap', (tx) =>
          rewrapBatch(tx, K2, { limit: 3, ...(after === undefined ? {} : { after }) }),
        )
        total += batch.rewrapped
        for (const u of batch.unreadable) {
          unreadable.add(u.secretId)
        }
        if (batch.next === undefined) {
          return { total, unreadable }
        }
        after = batch.next
      }
    }
    const [x, y] = await Promise.all([run(), run()])
    expect(x.total + y.total).toBe(referencedByK1 - 1)
    expect(new Set([...x.unreadable, ...y.unreadable]).size).toBe(1)

    const stuck = await keyringStatus(as('exdb_worker'), K2)
    expect(stuck.references.get('k1')).toBe(1)
    expect(stuck.removable).toEqual([])
    expect((await keyringStatus(as('exdb_worker'), K2_ONLY)).missing).toEqual(['k1'])
    expect((await keyringStatus(as('exdb_worker'), K1)).missing).toEqual(['k2'])

    const { rows } = await as('exdb_worker').query(
      'test.secret.any_worker',
      "SELECT secret_id FROM secrets.secret_versions WHERE consumer = 'worker' AND purpose = 'test.worker' ORDER BY created_at LIMIT 1",
    )
    const secretId = expectOk(parseId('sec', rows[0]?.text('secret_id')), 'secret id')
    expect(
      (await readSecret(as('exdb_worker'), K2_ONLY, { secretId, consumer: 'worker' })).length,
    ).toBeGreaterThan(0)
  })
})

describe('no key material or plaintext in the Control Store', () => {
  it('a scan of every row of every ExponetDB table finds no master key and no plaintext', async () => {
    const needles = [
      ...[0x11, 0x22].flatMap((n) => [keyBytes(n).toString('base64'), keyBytes(n).toString('hex')]),
      ...PLAINTEXTS.flatMap((p) => [p, Buffer.from(p).toString('hex')]),
    ]
    const dump = await db.asSuperuser(async (c) => {
      const tables = await c.query(
        `SELECT format('%I.%I', n.nspname, cl.relname) AS name
           FROM pg_catalog.pg_class cl JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace
          WHERE n.nspname IN ('control', 'audit', 'secrets', 'policy', 'operations') AND cl.relkind IN ('r', 'p')`,
      )
      const parts: string[] = []
      for (const t of tables.rows) {
        const rows = await c.query(`SELECT t::text AS row FROM ${String(t.name)} t`)
        for (const r of rows.rows) {
          parts.push(String(r.row))
        }
      }
      return parts.join('\n')
    })
    expect(dump).toContain('\\x')
    for (const needle of needles) {
      expect(dump.includes(needle), `found ${needle.slice(0, 8)}…`).toBe(false)
    }
  })
})
