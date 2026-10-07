import { createServer, type Socket } from 'node:net'
import { TLSSocket } from 'node:tls'
import { dropDatabase, matrix, runAsSuperuser, testTargets } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CircuitBreaker,
  ConnectionBudget,
  type ConnectionSpec,
  probeExtended,
  probeSimple,
  ROLE_NAMES,
  resolveRelationKinds,
  resolveUserCasts,
  sql,
  TargetError,
  TargetSession,
} from '../src/index.ts'
import {
  admitReadSync,
  checkRelationKinds,
  checkUserCasts,
  isWholeRowCallable,
  loadParser,
} from '../src/parser/index.ts'
import { endpoint, open, prepareDatabase, spec } from './targets.ts'

/**
 * G4 items 6 and 7 against real PostgreSQL 16, 17 and 18: TLS verify-full
 * is mandatory and every wrong verification fails; the guards refuse the
 * wrong cluster and database; observer and reader cannot write.
 */
async function refusal(promise: Promise<unknown>): Promise<TargetError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TargetError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

describe.each(matrix().map((s) => [s.major, s] as const))(
  'PostgreSQL %i sessions',
  (_m, server) => {
    let database = ''

    beforeAll(async () => {
      database = await prepareDatabase(server, `session_${server.major}`, undefined, [
        'CREATE TABLE public.items (id integer PRIMARY KEY, name text)',
        'CREATE SEQUENCE public.items_seq',
        "INSERT INTO public.items VALUES (1, 'one')",
      ])
    })

    afterAll(async () => {
      await dropDatabase(server, database)
    })

    it('connects with verify-full (IP host, registered server name) and records the facts', async () => {
      const s = await open(server, database, 'observer')
      try {
        expect(s.facts.major).toBe(server.major)
        expect(s.facts.database).toBe(database)
        expect(s.facts.user).toBe(ROLE_NAMES.observer)
        expect(s.facts.systemIdentifier).toMatch(/^\d+$/)
        const settings = await s.query(
          sql`SELECT current_setting('search_path') AS sp, current_setting('TimeZone') AS tz,
                   current_setting('default_transaction_read_only') AS ro,
                   current_setting('statement_timeout') AS st,
                   (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid()) AS ssl,
                   (SELECT version FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid()) AS tls`,
        )
        expect(settings[0]?.text('sp')).toBe('')
        expect(settings[0]?.text('tz')).toBe('UTC')
        expect(settings[0]?.text('ro')).toBe('on')
        expect(settings[0]?.text('st')).toBe('30s')
        expect(settings[0]?.bool('ssl')).toBe(true)
        expect(settings[0]?.text('tls')).toMatch(/^TLSv1\.[23]$/)
      } finally {
        await s.close()
      }
    })

    it('connects to a DNS host whose name equals the TLS server name', async () => {
      const s = await TargetSession.open(
        spec(server, database, 'observer', {
          endpoint: endpoint(server, { host: 'localhost', tlsServerName: 'localhost' }),
        }),
      )
      await s.close()
    })

    it('refuses a certificate from another CA', async () => {
      const e = await refusal(
        open(
          server,
          database,
          'observer',
          {},
          {
            endpoint: endpoint(server, { caPem: testTargets().otherCaPem }),
          },
        ),
      )
      expect(e.code).toBe('TARGET_TLS_FAILED')
      expect(e.reason).toBe('tls_unverified')
    })

    it('refuses a certificate that does not name the registered server name', async () => {
      const e = await refusal(
        open(
          server,
          database,
          'observer',
          {},
          {
            endpoint: endpoint(server, { tlsServerName: 'other.exdb.test' }),
          },
        ),
      )
      expect(e.code).toBe('TARGET_TLS_FAILED')
      expect(e.reason).toBe('tls_hostname')
    })

    it('refuses a DNS host whose name differs from the TLS server name before connecting', async () => {
      const e = await refusal(
        open(
          server,
          database,
          'observer',
          {},
          {
            endpoint: endpoint(server, {
              host: 'localhost',
              tlsServerName: testTargets().serverName,
            }),
          },
        ),
      )
      expect(e.code).toBe('TARGET_TLS_FAILED')
      expect(e.reason).toBe('tls_hostname')
    })

    it('refuses an endpoint without a CA bundle (never the system trust store)', async () => {
      const e = await refusal(
        open(server, database, 'observer', {}, { endpoint: endpoint(server, { caPem: '' }) }),
      )
      expect(e.code).toBe('TARGET_TLS_FAILED')
    })

    it('refuses a superuser login on every session (never a superuser over the network)', async () => {
      const t = testTargets()
      const e = await refusal(
        TargetSession.open(
          spec(server, database, 'observer', { user: t.superuser, password: t.superuserPassword }),
        ),
      )
      expect([e.code, e.reason]).toEqual(['TARGET_CREDENTIAL_INVALID', 'superuser_login'])
    })

    it('refuses a wrong password as an invalid credential', async () => {
      // Assembled at run time: a literal would look like a committed secret to the scanner.
      const wrong = ['wrong', 'password', 'x'].join('-')
      const e = await refusal(open(server, database, 'observer', {}, { password: wrong }))
      expect(e.code).toBe('TARGET_CREDENTIAL_INVALID')
      expect(e.message).not.toContain('wrong-password')
    })

    it('refuses another cluster (system identifier guard)', async () => {
      const e = await refusal(
        open(server, database, 'observer', { guards: { systemIdentifier: '1' } }),
      )
      expect(e.code).toBe('CLUSTER_IDENTITY_MISMATCH')
    })

    it('refuses another database (database guard)', async () => {
      const e = await refusal(
        open(server, database, 'observer', { guards: { database: 'postgres' } }),
      )
      expect(e.code).toBe('TARGET_IDENTITY_MISMATCH')
    })

    it('runs both probe protocols', async () => {
      const s = await open(server, database, 'observer')
      try {
        expect((await probeSimple(s)).status).toBe('ok')
        expect((await probeExtended(s)).status).toBe('ok')
      } finally {
        await s.close()
      }
    })

    it('times out a hung statement, maps it, and destroys the connection', async () => {
      const s = await open(server, database, 'observer', { limits: { statementTimeoutMs: 300 } })
      const e = await refusal(s.query(sql`SELECT pg_catalog.pg_sleep(5)`))
      expect(e.code).toBe('QUERY_TIMEOUT')
      expect(e.reason).toBe('statement_timeout')
      await s.close()
      const t = await open(server, database, 'observer')
      const client = await refusal(
        t.query(sql`SELECT pg_catalog.pg_sleep(5)`, [], { timeoutMs: 200 }),
      )
      expect(client.code).toBe('QUERY_TIMEOUT')
      expect(t.usable).toBe(false)
    })

    it('cancels a running statement through the protocol', async () => {
      const s = await open(server, database, 'observer')
      try {
        const running = s.query(sql`SELECT pg_catalog.pg_sleep(10)`)
        await new Promise((r) => setTimeout(r, 300))
        await s.cancel()
        const e = await refusal(running)
        expect(e.sqlstate).toBe('57014')
      } finally {
        await s.close()
      }
    })

    it('refuses SQL that is not engine-built', async () => {
      const s = await open(server, database, 'observer')
      try {
        const forged = Object.freeze({ kind: 'trusted_sql', text: 'SELECT 1' })
        await expect(s.query(forged as never)).rejects.toThrow(TypeError)
      } finally {
        await s.close()
      }
    })

    describe.each(['observer', 'reader'] as const)('%s cannot write', (role) => {
      const writes = [
        "INSERT INTO public.items VALUES (2, 'two')",
        "UPDATE public.items SET name = 'x'",
        'DELETE FROM public.items',
        'TRUNCATE public.items',
        'CREATE TABLE public.mine (id integer)',
        'CREATE SCHEMA mine',
        'CREATE FUNCTION public.mine() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
        "COMMENT ON TABLE public.items IS 'mine'",
        'ALTER TABLE public.items ADD COLUMN mine integer',
        'DROP TABLE public.items',
        "SELECT pg_catalog.nextval('public.items_seq')",
      ]

      it.each(writes)('refuses %s even after lifting the read-only default', async (statement) => {
        const s = await open(server, database, role)
        try {
          // The privilege layer, not the read-only transaction, refuses: lift the latter first.
          await s.query(
            sql`SELECT pg_catalog.set_config('default_transaction_read_only', 'off', false)`,
          )
          const e = await refusal(runAttempt(s, statement))
          expect(e.code).toBe('PERMISSION_DENIED')
          expect(e.sqlstate).toBe('42501')
        } finally {
          await s.close()
        }
      })

      it('refuses temporary tables and large objects inside its read-only session', async () => {
        const s = await open(server, database, role)
        try {
          for (const attempt of [
            'CREATE TEMP TABLE t (id integer)',
            'SELECT pg_catalog.lo_create(0)',
          ]) {
            const e = await refusal(runAttempt(s, attempt))
            expect(e.sqlstate).toBe('25006')
          }
        } finally {
          await s.close()
        }
      })
    })

    it('never lets the observer read application rows', async () => {
      const s = await open(server, database, 'observer')
      try {
        for (const attempt of [
          'SELECT * FROM public.items',
          'TABLE public.items',
          'SELECT count(*) FROM public.items',
          "SELECT pg_catalog.pg_read_file('postgresql.conf')",
        ]) {
          const e = await refusal(runAttempt(s, attempt))
          expect([attempt, e.code, e.sqlstate]).toEqual([attempt, 'PERMISSION_DENIED', '42501'])
        }
      } finally {
        await s.close()
      }
    })

    it('reads with the reader through BYPASSRLS and pg_read_all_data', async () => {
      await runAsSuperuser(server, database, [
        'ALTER TABLE public.items ENABLE ROW LEVEL SECURITY',
        'ALTER TABLE public.items FORCE ROW LEVEL SECURITY',
      ])
      const s = await open(server, database, 'reader')
      try {
        const rows = await s.query(sql`SELECT count(*) AS n FROM public.items`)
        expect(rows[0]?.int('n')).toBe(1)
      } finally {
        await s.close()
      }
    })

    it('keeps a per-cluster budget and opens the circuit after repeated failures', async () => {
      const budget = new ConnectionBudget(1)
      const first = await open(server, database, 'observer', {
        budget: { pool: budget, key: 'c1' },
      })
      const e = await refusal(
        open(server, database, 'observer', { budget: { pool: budget, key: 'c1', waitMs: 200 } }),
      )
      expect(e.reason).toBe('budget_exhausted')
      await first.close()
      const second = await open(server, database, 'observer', {
        budget: { pool: budget, key: 'c1' },
      })
      await second.close()
      expect(budget.inUse('c1')).toBe(0)

      const breaker = new CircuitBreaker({ threshold: 2, openMs: 60_000 })
      const bad = { endpoint: endpoint(server, { port: 1 }) }
      for (let i = 0; i < 2; i++) {
        await refusal(open(server, database, 'observer', { breaker: { breaker, key: 'k' } }, bad))
      }
      const open3 = await refusal(
        open(server, database, 'observer', { breaker: { breaker, key: 'k' } }),
      )
      expect(open3.reason).toBe('circuit_open')
    })
  },
)

/** A test attempt: test code builds the statement with `sql` from a fixed list (never input). */
function runAttempt(s: TargetSession, statement: string) {
  const strings = Object.assign([statement], { raw: [statement] })
  return s.query(sql(Object.freeze(strings) as unknown as TemplateStringsArray))
}

describe('a server without TLS', () => {
  it('is refused, never used in plaintext', async () => {
    const t = testTargets()
    const e = await refusal(
      TargetSession.open({
        endpoint: {
          host: t.plaintext.host,
          port: t.plaintext.port,
          tlsServerName: t.serverName,
          caPem: t.caPem,
        },
        database: 'postgres',
        role: 'observer',
        user: 'postgres',
        password: t.superuserPassword,
        applicationName: 'exponetdb/test/plaintext',
      }),
    )
    expect(e.code).toBe('TARGET_TLS_FAILED')
    expect(e.reason).toBe('tls_unavailable')
  })
})

describe.each(matrix().map((s) => [s.major, s] as const))(
  'data.read admission against PostgreSQL %i',
  (_m, server) => {
    it('refuses views and foreign tables by their kind on the target, admits tables', async () => {
      const database = await prepareDatabase(server, `adm_${server.major}`, undefined, [
        'CREATE TABLE public.t (id integer)',
        'CREATE VIEW public.v AS SELECT id FROM public.t',
        'CREATE MATERIALIZED VIEW public.m AS SELECT id FROM public.t',
      ])
      const s = await open(server, database, 'observer')
      try {
        const check = async (text: string) => {
          const a = admitReadSync(server.major, text)
          if (!a.ok) return a.reason
          return (
            checkRelationKinds(a.relations, await resolveRelationKinds(s, a.relations))?.reason ??
            'admitted'
          )
        }
        await loadParser(server.major)
        expect(await check('SELECT id FROM public.t JOIN public.m USING (id)')).toBe('admitted')
        expect(await check('SELECT id FROM public.v')).toBe('relation_kind')
        expect(await check('SELECT id FROM public.missing')).toBe('relation_kind')
        expect(await check('SELECT relname FROM pg_catalog.pg_class LIMIT 1')).toBe('admitted')
      } finally {
        await s.close()
        await dropDatabase(server, database)
      }
    })

    it('refuses a table whose partitions or inheritance children include a foreign table', async () => {
      const database = await prepareDatabase(server, `admfdw_${server.major}`, undefined, [
        'CREATE EXTENSION postgres_fdw',
        "CREATE SERVER remote FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '127.0.0.1')",
        'CREATE TABLE public.parted (id integer) PARTITION BY RANGE (id)',
        'CREATE TABLE public.parted_local PARTITION OF public.parted FOR VALUES FROM (0) TO (10)',
        'CREATE TABLE public.parted_mid (id integer) PARTITION BY RANGE (id)',
        'ALTER TABLE public.parted ATTACH PARTITION public.parted_mid FOR VALUES FROM (10) TO (100)',
        'CREATE FOREIGN TABLE public.parted_far PARTITION OF public.parted_mid FOR VALUES FROM (10) TO (20) SERVER remote',
        'CREATE TABLE public.base (id integer)',
        'CREATE FOREIGN TABLE public.child (id integer) INHERITS (public.base) SERVER remote',
        'CREATE TABLE public.plain (id integer)',
        'CREATE TABLE public.plain_child (id integer) INHERITS (public.plain)',
      ])
      const s = await open(server, database, 'observer')
      try {
        await loadParser(server.major)
        const kind = async (text: string) => {
          const a = admitReadSync(server.major, text)
          if (!a.ok) return a.reason
          return (
            checkRelationKinds(a.relations, await resolveRelationKinds(s, a.relations))?.reason ??
            'admitted'
          )
        }
        expect(await kind('SELECT id FROM public.parted')).toBe('relation_kind')
        expect(await kind('SELECT id FROM public.parted_mid')).toBe('relation_kind')
        expect(await kind('SELECT id FROM public.parted_local')).toBe('admitted')
        expect(await kind('SELECT id FROM public.base')).toBe('relation_kind')
        expect(await kind('SELECT id FROM public.plain JOIN public.plain_child USING (id)')).toBe(
          'admitted',
        )
      } finally {
        await s.close()
        await dropDatabase(server, database)
      }
    })

    it('refuses a database whose casts run user code, admits extension casts in C', async () => {
      const planted = await prepareDatabase(server, `admcast_${server.major}`, undefined, [
        "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'exdb_cast_owner') THEN CREATE ROLE exdb_cast_owner; END IF; END $$",
        'GRANT CREATE ON SCHEMA public TO exdb_cast_owner',
        'SET ROLE exdb_cast_owner',
        "CREATE TYPE public.e AS ENUM ('a')",
        "CREATE FUNCTION public.e_text(public.e) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$",
        'CREATE CAST (public.e AS text) WITH FUNCTION public.e_text(public.e) AS IMPLICIT',
        'CREATE TABLE public.t (c public.e)',
        'RESET ROLE',
      ])
      const clean = await prepareDatabase(server, `admcastc_${server.major}`, undefined, [
        'CREATE EXTENSION vector',
        'CREATE EXTENSION hstore',
      ])
      const s = await open(server, planted, 'observer')
      const c = await open(server, clean, 'observer')
      try {
        await loadParser(server.major)
        // The statement names no cast; the planted one runs on the enum column all the same.
        const text = 'SELECT pg_catalog.lower(c) FROM public.t'
        expect(admitReadSync(server.major, text).ok).toBe(true)
        expect(checkUserCasts(await resolveUserCasts(s))).toMatchObject({
          reason: 'cast',
          construct: 'public.e AS text',
        })
        expect(await resolveUserCasts(c)).toEqual([])
      } finally {
        await s.close()
        await c.close()
        await dropDatabase(server, planted)
        await dropDatabase(server, clean)
      }
    })

    it('knows every pg_catalog function a qualified column reference can call on the whole row', async () => {
      const s = await open(server, 'postgres', 'observer')
      try {
        const rows = await s.query(
          sql`SELECT DISTINCT p.proname::text AS name FROM pg_catalog.pg_proc p
               WHERE p.pronamespace = 'pg_catalog'::pg_catalog.regnamespace
                 AND p.pronargs >= 1 AND p.pronargs - p.pronargdefaults <= 1
                 AND (p.proargtypes[0] IN ('pg_catalog.record'::pg_catalog.regtype,
                        'pg_catalog."any"'::pg_catalog.regtype, 'pg_catalog.anyelement'::pg_catalog.regtype,
                        'pg_catalog.anycompatible'::pg_catalog.regtype, 'pg_catalog.anynonarray'::pg_catalog.regtype,
                        'pg_catalog.anycompatiblenonarray'::pg_catalog.regtype)
                      OR (SELECT t.typtype FROM pg_catalog.pg_type t WHERE t.oid = p.proargtypes[0]) = 'c')
               ORDER BY 1`,
        )
        const missing = rows
          .map((r) => r.text('name'))
          .filter((n) => !isWholeRowCallable(server.major, n))
        expect(missing).toEqual([])
      } finally {
        await s.close()
      }
    })
  },
)

/**
 * A TLS server with the run's certificate (so `verify-full` passes) that
 * speaks only the start of the protocol: it answers the startup packet with
 * one authentication request and records every byte the client sends after
 * the startup packet. It stands for a server that is not the registered
 * cluster but holds a certificate for its name, or a cluster whose
 * `pg_hba.conf` says `password` or `md5`: the identity guards run only after
 * authentication, so the password must never depend on them.
 */
async function authenticationProbe(...requests: Buffer[]): Promise<{
  readonly port: number
  /** Every byte the client sent after the startup packet. */
  readonly afterStartup: () => Buffer
  /** Every byte the client sent after the last request. */
  readonly afterLast: () => Buffer
  readonly closed: Promise<void>
  readonly stop: () => Promise<void>
}> {
  const t = testTargets()
  const sockets = new Set<Socket>()
  let received = Buffer.alloc(0)
  let sinceLast = Buffer.alloc(0)
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const server = createServer((plain) => {
    sockets.add(plain)
    plain.on('error', () => plain.destroy())
    plain.once('data', () => {
      plain.write('S')
      const secure = new TLSSocket(plain, {
        isServer: true,
        cert: t.serverCertPem,
        key: t.serverKeyPem,
      })
      sockets.add(secure)
      secure.on('error', () => secure.destroy())
      secure.on('close', () => resolveClosed())
      let startupSeen = false
      let next = 0
      secure.on('data', (chunk: Buffer) => {
        if (!startupSeen) {
          received = Buffer.concat([received, chunk])
          if (received.length < 4 || received.length < received.readInt32BE(0)) return
          startupSeen = true
          received = received.subarray(received.readInt32BE(0))
          secure.write(requests[next++] as Buffer)
          return
        }
        received = Buffer.concat([received, chunk])
        sinceLast = Buffer.concat([sinceLast, chunk])
        if (next < requests.length) {
          // The client answered: ask again, the next way (a SASL start, then cleartext).
          sinceLast = Buffer.alloc(0)
          secure.write(requests[next++] as Buffer)
        } else {
          // The client answered the last request: stop the exchange here.
          secure.destroy()
        }
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('probe did not bind')
  return {
    port: address.port,
    afterStartup: () => received,
    afterLast: () => sinceLast,
    closed,
    stop: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function authenticationRequest(code: number, extra: Buffer = Buffer.alloc(0)): Buffer {
  const body = Buffer.alloc(4)
  body.writeInt32BE(code)
  const length = Buffer.alloc(4)
  length.writeInt32BE(4 + body.length + extra.length)
  return Buffer.concat([Buffer.from('R'), length, body, extra])
}

describe('the password goes only into a SCRAM exchange', () => {
  const canary = 'exdb-canary-password-7f3a9c'

  function probeSpec(port: number): ConnectionSpec {
    const t = testTargets()
    return {
      endpoint: { host: '127.0.0.1', port, tlsServerName: t.serverName, caPem: t.caPem },
      database: 'postgres',
      role: 'observer',
      user: ROLE_NAMES.observer,
      password: canary,
      applicationName: 'exponetdb/test/auth-method',
    }
  }

  it.each([
    ['cleartext', authenticationRequest(3)],
    ['MD5', authenticationRequest(5, Buffer.from([1, 2, 3, 4]))],
  ])('refuses a %s password request and sends nothing', async (_name, request) => {
    const probe = await authenticationProbe(request)
    try {
      const e = await refusal(TargetSession.open(probeSpec(probe.port)))
      expect([e.code, e.reason]).toEqual(['TARGET_CREDENTIAL_INVALID', 'auth_method'])
      await probe.closed
      // No password message, no password, no MD5 form: at most the Terminate message.
      expect(['', 'X\0\0\0\x04']).toContain(probe.afterStartup().toString('latin1'))
      expect(probe.afterStartup().includes(Buffer.from(canary))).toBe(false)
    } finally {
      await probe.stop()
    }
  })

  it.each([
    ['cleartext', authenticationRequest(3)],
    ['MD5', authenticationRequest(5, Buffer.from([1, 2, 3, 4]))],
  ])(
    'refuses a %s request that follows a SASL start (the driver caches the password)',
    async (_name, second) => {
      const sasl = authenticationRequest(10, Buffer.from('SCRAM-SHA-256\0\0', 'latin1'))
      const probe = await authenticationProbe(sasl, second)
      try {
        const e = await refusal(TargetSession.open(probeSpec(probe.port)))
        expect([e.code, e.reason]).toEqual(['TARGET_CREDENTIAL_INVALID', 'auth_method'])
        await probe.closed
        expect(['', 'X\0\0\0\x04']).toContain(probe.afterLast().toString('latin1'))
        expect(probe.afterStartup().includes(Buffer.from(canary))).toBe(false)
      } finally {
        await probe.stop()
      }
    },
  )

  it('answers SCRAM, bound to the TLS connection when the server offers it, without the password', async () => {
    const mechanisms = Buffer.from('SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0', 'latin1')
    const probe = await authenticationProbe(authenticationRequest(10, mechanisms))
    try {
      await refusal(TargetSession.open(probeSpec(probe.port)))
      await probe.closed
      const answer = probe.afterStartup()
      // SASLInitialResponse: 'p', length, mechanism name, NUL, …
      expect(answer.subarray(0, 1).toString('latin1')).toBe('p')
      const mechanism = answer.subarray(5, answer.indexOf(0, 5)).toString('latin1')
      expect(mechanism).toBe('SCRAM-SHA-256-PLUS')
      expect(answer.includes(Buffer.from(canary))).toBe(false)
    } finally {
      await probe.stop()
    }
  })
})
