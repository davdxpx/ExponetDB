import { scramSha256Verifier } from '@exponetdb/kernel/hash'
import { describe, expect, it } from 'vitest'
import {
  bootstrapScript,
  CircuitBreaker,
  ConnectionBudget,
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  documentFromJson,
  documentJson,
  endpointProblem,
  fingerprintOf,
  ident,
  isTrustedSql,
  lockKey2,
  makeDocument,
  makeEntry,
  mapDriverError,
  passwordStatements,
  quoteIdent,
  quoteLiteral,
  SqlBuildError,
  scopeHeader,
  sql,
} from '../src/index.ts'

describe('TrustedSql', () => {
  it('is created by the builder only and cannot be forged', () => {
    const a = sql`SELECT 1`
    expect(isTrustedSql(a)).toBe(true)
    expect(Object.isFrozen(a)).toBe(true)
    expect(isTrustedSql({ kind: 'trusted_sql', text: 'SELECT 1' })).toBe(false)
    expect(isTrustedSql(Object.freeze({ ...a }))).toBe(false)
    // A plain array is not a template literal.
    expect(() => sql(['DROP TABLE x'] as unknown as TemplateStringsArray)).toThrow(SqlBuildError)
    // An interpolated value that is not a fragment is refused (values travel as parameters).
    expect(() => sql`SELECT ${'1; DROP TABLE x' as never}`).toThrow(SqlBuildError)
    expect(sql`SELECT ${ident('a"b')} FROM ${sql`t`}`.text).toBe('SELECT "a""b" FROM t')
  })

  it('always quotes identifiers, refuses NUL, the empty name and names the server would truncate', () => {
    expect(quoteIdent('select')).toBe('"select"')
    expect(quoteIdent('a"b')).toBe('"a""b"')
    expect(() => quoteIdent('')).toThrow(SqlBuildError)
    expect(() => quoteIdent('a\u0000b')).toThrow(SqlBuildError)
    expect(() => ident('x'.repeat(64))).toThrow(SqlBuildError)
    expect(() => ident('é'.repeat(32))).toThrow(SqlBuildError)
    expect(ident('é'.repeat(31)).text).toBe(`"${'é'.repeat(31)}"`)
  })

  it('quotes literals as E-strings with backslashes and quotes doubled', () => {
    expect(quoteLiteral("it's \\")).toBe("E'it''s \\\\'")
    expect(() => quoteLiteral('\u0000')).toThrow(SqlBuildError)
  })
})

describe('endpoints', () => {
  const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'
  it.each([
    [{ host: 'db.example.test', port: 5432, tlsServerName: 'db.example.test', caPem: ca }, null],
    [{ host: '10.0.0.5', port: 5432, tlsServerName: 'db.example.test', caPem: ca }, null],
    [
      { host: 'db.example.test', port: 5432, tlsServerName: 'other.example.test', caPem: ca },
      'server_name',
    ],
    [{ host: '10.0.0.5', port: 5432, tlsServerName: '10.0.0.5', caPem: ca }, 'server_name'],
    [{ host: 'postgres://u:p@h/db', port: 5432, tlsServerName: 'h', caPem: ca }, 'host'],
    [{ host: 'db.example.test', port: 0, tlsServerName: 'db.example.test', caPem: ca }, 'port'],
    [{ host: 'db.example.test', port: 5432, tlsServerName: 'db.example.test', caPem: '' }, 'ca'],
  ] as const)('checks %j', (endpoint, problem) => {
    expect(endpointProblem(endpoint)).toBe(problem)
  })
})

describe('bootstrap SQL', () => {
  it('creates the roles without any password unless a SCRAM verifier is given', () => {
    const script = bootstrapScript(['app_db'])
    expect(script).not.toMatch(/PASSWORD/)
    expect(script).toContain('CREATE ROLE "exponetdb_ledger_owner" NOLOGIN')
    expect(script).toContain(
      'GRANT "pg_monitor" TO "exponetdb_observer" WITH INHERIT TRUE, SET FALSE',
    )
    expect(script).toContain(
      'GRANT "exponetdb_ledger_owner" TO "exponetdb_migrator" WITH INHERIT FALSE, SET TRUE',
    )
    expect(script).toContain('GRANT CREATE ON DATABASE "app_db" TO "exponetdb_ledger_owner"')
    // Six roles, each created when missing and altered to the same attributes otherwise.
    const roleLines = script
      .split('\n')
      .filter((l) => /^\s*(CREATE|ALTER) ROLE "[a-z_]+" (NO)?LOGIN/.test(l))
    expect(roleLines).toHaveLength(12)
    for (const line of roleLines) {
      expect(line).toContain('NOSUPERUSER')
      expect(line).not.toMatch(/ SUPERUSER| CREATEROLE| REPLICATION/)
    }
    const verifier = scramSha256Verifier('a'.repeat(32), { salt: new Uint8Array(16) })
    const withVerifier = clusterBootstrapStatements({ observer: verifier }).join('\n')
    expect(withVerifier).toContain(`PASSWORD E'${verifier}'`)
    expect(passwordStatements({ reader: verifier })).toEqual([
      `ALTER ROLE "exponetdb_reader" PASSWORD E'${verifier}'`,
    ])
  })

  it('guards every statement that would fail on a second run', () => {
    const script = bootstrapScript(['app_db'])
    // No bare CREATE: each one sits in a DO block that checks the catalog first.
    for (const line of script.split('\n').filter((l) => /^\s*CREATE /.test(l))) {
      expect(line).toMatch(/^ {4}CREATE ROLE /)
    }
    expect(
      script.match(/IF NOT EXISTS \(SELECT FROM pg_catalog\.pg_roles WHERE rolname = /g),
    ).toHaveLength(6)
    expect(script).toContain(
      "IF EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = E'app_db') THEN",
    )
  })

  it('grants execution roles from the registry only where they are fit, never a protected one', () => {
    const script = bootstrapScript([], {
      executionRoles: [
        { name: 'app_owner', bypassRlsExcused: false },
        { name: 'adopted_owner', bypassRlsExcused: true },
        { name: 'app_owner', bypassRlsExcused: false },
      ],
    })
    expect(
      script.match(/GRANT "[a-z_]+" TO "exponetdb_migrator" WITH INHERIT FALSE, SET TRUE;/g),
    ).toEqual([
      'GRANT "exponetdb_ledger_owner" TO "exponetdb_migrator" WITH INHERIT FALSE, SET TRUE;',
      'GRANT "adopted_owner" TO "exponetdb_migrator" WITH INHERIT FALSE, SET TRUE;',
      'GRANT "app_owner" TO "exponetdb_migrator" WITH INHERIT FALSE, SET TRUE;',
    ])
    // BYPASSRLS refuses the grant unless a declared exception excuses it.
    const blocks = script.split(/^DO /m)
    const excused = blocks.find((b) => b.includes('"adopted_owner" TO'))
    const plain = blocks.find((b) => b.includes('"app_owner" TO'))
    expect(excused).not.toContain('r.rolbypassrls')
    expect(plain).toContain('r.rolbypassrls')
    for (const b of [excused, plain]) {
      expect(b).toContain(
        'r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication',
      )
      expect(b).toContain(String.raw`x.rolname LIKE 'pg\_%' OR x.rolname LIKE 'exponetdb\_%'`)
    }
    for (const name of ['pg_read_all_data', 'exponetdb_ledger_owner']) {
      expect(() =>
        bootstrapScript([], { executionRoles: [{ name, bypassRlsExcused: false }] }),
      ).toThrow()
    }
  })

  it('connects psql to each database by name only for the legacy ledger read', () => {
    const script = bootstrapScript([String.raw`we'ird\db host=evil`, 'app'], {
      legacyLedgers: ['supabase', 'supabase', 'drizzle'],
    })
    // A conninfo string with only dbname, single-quoted for psql: never a host, a variable
    // or a backquote command.
    expect(script).toContain(
      String.raw`\connect -reuse-previous=on 'dbname=''we\\''ird\\\\db host=evil'''`,
    )
    expect(script).toContain(String.raw`\connect -reuse-previous=on 'dbname=''app'''`)
    expect(
      script.match(
        /GRANT SELECT ON "supabase_migrations"\."schema_migrations" TO "exponetdb_observer";/g,
      ),
    ).toHaveLength(2)
    expect(
      script.match(/GRANT SELECT ON "drizzle"\."__drizzle_migrations" TO "exponetdb_observer";/g),
    ).toHaveLength(2)
    expect(bootstrapScript(['app'])).not.toContain(String.raw`\connect`)
    // Each grant block checks that psql reached the database it names.
    expect(script).toContain(
      "IF pg_catalog.current_database() OPERATOR(pg_catalog.<>) E'app' THEN\n    RAISE EXCEPTION 'connected to database % instead of %",
    )
    // psql drops double quotes from a \connect argument: such a name gets no \connect at
    // all (it would reach "qwe"), only a message for the person running the script.
    const quoted = bootstrapScript(['q"w"e'], { legacyLedgers: ['supabase'] })
    expect(quoted).not.toContain(String.raw`\connect`)
    expect(quoted).not.toContain('GRANT SELECT ON "supabase_migrations"')
    expect(quoted).toContain(String.raw`\echo 'database q"w"e: its name holds a double quote`)
    expect(() => bootstrapScript(['a\nb'])).toThrow()
    expect(() => bootstrapScript([''])).toThrow()
  })

  it('stays within the response limit at the largest registry state', () => {
    // 1 000 registered and 32 requested databases of 63 bytes, three ledgers, 1 024 roles.
    const names = Array.from(
      { length: 1032 },
      (_, i) => `${'d'.repeat(58)}${String(i).padStart(5, '0')}`,
    )
    const script = bootstrapScript(names, {
      executionRoles: Array.from({ length: 1024 }, (_, i) => ({
        name: `${'r'.repeat(58)}${String(i).padStart(5, '0')}`,
        bypassRlsExcused: i % 2 === 0,
      })),
      legacyLedgers: ['supabase', 'drizzle', 'applied_migrations'],
    })
    expect(script.length).toBeLessThan(8_388_608)
  })

  it('refuses a plaintext password in place of a verifier', () => {
    expect(() => clusterBootstrapStatements({ observer: 'plaintext-password' })).toThrow()
    expect(() => passwordStatements({ observer: "x' SUPERUSER '" })).toThrow()
  })

  it('quotes database names', () => {
    expect(databaseBootstrapStatements('a"b')[1]).toBe(
      'GRANT CREATE ON DATABASE "a""b" TO "exponetdb_ledger_owner"',
    )
  })
})

describe('advisory lock key', () => {
  it('derives key2 from SHA-256("exponetdb/lock/v1/<class>/<target>")', () => {
    const k = lockKey2('schema', 'tgt_01M4A000000000000000000010')
    expect(Number.isInteger(k)).toBe(true)
    expect(k).toBeGreaterThanOrEqual(-(2 ** 31))
    expect(k).toBeLessThan(2 ** 31)
    expect(lockKey2('maintenance', 'tgt_01M4A000000000000000000010')).not.toBe(k)
    expect(lockKey2('schema', 'tgt_01M4A000000000000000000010')).toBe(k)
  })
})

describe('budget and breaker', () => {
  it('limits connections per cluster and wakes waiters in order', async () => {
    const b = new ConnectionBudget(2)
    const r1 = await b.acquire('c', 100)
    const r2 = await b.acquire('c', 100)
    await expect(b.acquire('c', 20)).rejects.toMatchObject({ reason: 'budget_exhausted' })
    const pending = b.acquire('c', 1000)
    r1()
    r1()
    const r3 = await pending
    expect(b.inUse('c')).toBe(2)
    r2()
    r3()
    expect(b.inUse('c')).toBe(0)
    expect(await b.acquire('other', 10)).toBeTypeOf('function')
  })

  it('opens after consecutive failures in the window and closes on success', () => {
    let now = 0
    const breaker = new CircuitBreaker({
      threshold: 3,
      windowMs: 60_000,
      openMs: 30_000,
      now: () => now,
    })
    breaker.failure('t')
    breaker.failure('t')
    breaker.check('t')
    breaker.failure('t')
    expect(() => breaker.check('t')).toThrow()
    now += 30_001
    breaker.check('t')
    breaker.failure('t')
    breaker.success('t')
    breaker.failure('t')
    breaker.failure('t')
    breaker.check('t')
  })
})

describe('error mapping', () => {
  it.each([
    [
      { code: '28P01', severity: 'FATAL', message: 'password authentication failed' },
      'TARGET_CREDENTIAL_INVALID',
    ],
    [
      { code: '57014', severity: 'ERROR', message: 'canceling statement due to statement timeout' },
      'QUERY_TIMEOUT',
    ],
    [
      {
        code: '25006',
        severity: 'ERROR',
        message: 'cannot execute INSERT in a read-only transaction',
      },
      'QUERY_NOT_READ_ONLY',
    ],
    [
      { code: '42501', severity: 'ERROR', message: 'permission denied for table t' },
      'PERMISSION_DENIED',
    ],
    [{ code: '42P01', severity: 'ERROR', message: 'relation does not exist' }, 'QUERY_PARSE_ERROR'],
    [{ code: '08006', severity: 'FATAL', message: 'x' }, 'TARGET_UNAVAILABLE'],
    [
      {
        code: '23505',
        severity: 'ERROR',
        message: 'duplicate key',
        detail: 'Key (email)=(a@b.de) already exists.',
      },
      'TARGET_SQL_ERROR',
    ],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'x' }, 'TARGET_TLS_FAILED'],
    [{ code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'x' }, 'TARGET_TLS_FAILED'],
    [{ code: 'ECONNREFUSED', message: 'x' }, 'TARGET_UNAVAILABLE'],
    [{ message: 'The server does not support SSL connections' }, 'TARGET_TLS_FAILED'],
  ] as const)('maps %j', (raw, code) => {
    const e = mapDriverError(Object.assign(new Error(raw.message), raw), 'query')
    expect(e.code).toBe(code)
    expect(JSON.stringify(e.server)).not.toContain('a@b.de')
    expect(e.message).not.toContain('a@b.de')
  })
})

describe('fp1 canonical form', () => {
  const header = scopeHeader(17, { excludeSchemas: ['auth'] })

  it('omits absent and default values and hashes entries over JCS', () => {
    const a = makeEntry('table', ['public', 't'], {
      rowSecurity: false,
      owner: 'o',
      reloptions: [],
      acl: undefined,
    })
    const b = makeEntry('table', ['public', 't'], { owner: 'o' })
    expect(a.hash).toBe(b.hash)
    expect(a.attributes).toEqual({ owner: 'o' })
    const c = makeEntry('table', ['public', 't'], { owner: 'o' }, 'a comment')
    expect(c.hash).toBe(a.hash)
    expect(c.documentation).toMatch(/^[0-9a-f]{64}$/)
  })

  it('sorts entries in UTF-8 byte order and refuses duplicate keys', () => {
    const doc = makeDocument(header, [
      makeEntry('table', ['public', 'b']),
      makeEntry('table', ['public', 'a']),
      makeEntry('schema', ['public']),
      makeEntry('table', ['public', 'É']),
      makeEntry('table', ['public', 'Z']),
    ])
    expect(doc.entries.map((e) => `${e.class}:${e.key.join('.')}`)).toEqual([
      'schema:public',
      'table:public.Z',
      'table:public.a',
      'table:public.b',
      'table:public.É',
    ])
    expect(() =>
      makeDocument(header, [makeEntry('schema', ['a']), makeEntry('schema', ['a'])]),
    ).toThrow()
  })

  it('keeps keys as lists so that dots and quotes never collide', () => {
    const doc1 = makeDocument(header, [makeEntry('table', ['a.b', 'c'])])
    const doc2 = makeDocument(header, [makeEntry('table', ['a', 'b.c'])])
    expect(fingerprintOf(doc1)).not.toBe(fingerprintOf(doc2))
  })

  it('binds the header (major and scope) into the fingerprint', () => {
    const entries = [makeEntry('schema', ['public'])]
    const f17 = fingerprintOf(makeDocument(header, entries))
    expect(f17).toMatch(/^fp1:17:[0-9a-f]{64}$/)
    expect(
      fingerprintOf(makeDocument(scopeHeader(18, { excludeSchemas: ['auth'] }), entries)),
    ).not.toBe(f17)
    expect(fingerprintOf(makeDocument(scopeHeader(17, {}), entries))).not.toBe(f17)
  })

  it('round-trips through JSON and refuses a changed entry', () => {
    const doc = makeDocument(header, [makeEntry('schema', ['public'], { owner: 'o' })])
    const json = documentJson(doc)
    const back = documentFromJson(json)
    expect(back === undefined ? undefined : fingerprintOf(back)).toBe(fingerprintOf(doc))
    const changed = JSON.parse(JSON.stringify(json))
    changed.entries[0].key = ['other']
    expect(documentFromJson(changed)).toBeUndefined()
  })
})
