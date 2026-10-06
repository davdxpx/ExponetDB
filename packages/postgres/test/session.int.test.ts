import { dropDatabase, matrix, runAsSuperuser, testTargets } from '@exponetdb/testkit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CircuitBreaker,
  ConnectionBudget,
  probeExtended,
  probeSimple,
  ROLE_NAMES,
  resolveRelationKinds,
  sql,
  TargetError,
  TargetSession,
} from '../src/index.ts'
import { admitReadSync, checkRelationKinds, loadParser } from '../src/parser/index.ts'
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
  },
)
