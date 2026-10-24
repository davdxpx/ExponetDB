import fc from 'fast-check'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  loadParser,
  RAW_MAX_LENGTH,
  REDACTED,
  redactStatementSync,
  revealStatementSync,
  SECRET_FUNCTIONS,
  type SupportedMajor,
  secretSpans,
} from '../src/parser/index.ts'
import { SUPPORTED_MAJORS } from '../src/versions.ts'

// Credential-shaped prefixes are assembled at run time so the repository's secret
// scan (tooling/checks/secrets.ts) does not see a credential in this file.
const PG = ['postgresql', '//'].join(':')
const PGS = ['postgres', '//'].join(':')
const BEGIN = ['-----BEGIN', ''].join(' ')

/**
 * The raw statement view's secret remover (owner decision S2, Wave 8;
 * statement-redaction.md §4): literals stay readable, credentials never
 * leave. Every case runs on every supported grammar.
 */
beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

const SECRET = 'S3cr3tV4lue'

const reveal = (text: string, major: SupportedMajor = 17, maxLength?: number) =>
  revealStatementSync(text, { major, ...(maxLength === undefined ? {} : { maxLength }) })

/** Statements whose secret must be removed, and the mode the answer has. */
const SECRETS: readonly (readonly [string, 'literal' | 'summary'])[] = [
  // Sensitive commands: the redactor's fixed summary, nothing of the statement.
  [`ALTER ROLE app PASSWORD '${SECRET}'`, 'summary'],
  [`ALTER USER app WITH ENCRYPTED PASSWORD '${SECRET}' VALID UNTIL 'infinity'`, 'summary'],
  [`CREATE ROLE app LOGIN PASSWORD '${SECRET}'`, 'summary'],
  [`CREATE USER app PASSWORD $$${SECRET}$$`, 'summary'],
  [`CREATE USER MAPPING FOR app SERVER s OPTIONS (user 'u', password '${SECRET}')`, 'summary'],
  [`ALTER USER MAPPING FOR app SERVER s OPTIONS (SET password '${SECRET}')`, 'summary'],
  [
    `CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'h', password '${SECRET}')`,
    'summary',
  ],
  [`SET app.api_token = '${SECRET}'`, 'summary'],
  [`SET app.secret TO ${SECRET}`, 'summary'],
  // ALTER … SET of a secret-named setting is a sensitive command like SET: its summary.
  [`ALTER SYSTEM SET my.password = '${SECRET}'`, 'summary'],
  [`ALTER DATABASE d SET app.private_key = '${SECRET}'`, 'summary'],
  [`SELECT set_config('app.token', '${SECRET}', false)`, 'summary'],
  [`COPY t FROM PROGRAM 'curl -H "x: ${SECRET}" https://example.test'`, 'summary'],
  [`SELECT 1; ALTER ROLE app PASSWORD '${SECRET}'`, 'summary'],
  // Cut at track_activity_query_size: the lexical summary.
  [`ALTER ROLE app PASSWORD '${SECRET}`, 'summary'],
  // Connection strings and URIs.
  [
    `SELECT * FROM dblink('host=db port=5432 user=u password=${SECRET} dbname=d', 'SELECT 1') AS t(a int)`,
    'literal',
  ],
  [
    `SELECT * FROM dblink('host=db password=''${SECRET} with space'' dbname=d', 'SELECT 1') AS t(a int)`,
    'literal',
  ],
  [`SELECT dblink_connect('c', 'dbname=d password=${SECRET}')`, 'literal'],
  [`SELECT dblink_connect('host=x user=u ${SECRET}')`, 'literal'],
  [
    `SELECT * FROM dblink('${PG}app:${SECRET}@db.example.test:5432/d', 'SELECT 1') AS t(a int)`,
    'literal',
  ],
  [
    `SELECT * FROM dblink('${PGS}app:${SECRET}@db/d?sslmode=require', 'SELECT 1') AS t(a int)`,
    'literal',
  ],
  [
    `SELECT * FROM dblink('postgresql://db/d?user=app&password=${SECRET}', 'SELECT 1') AS t(a int)`,
    'literal',
  ],
  [`SELECT * FROM dblink('host=db sslpassword=${SECRET}', 'SELECT 1') AS t(a int)`, 'literal'],
  [
    `CREATE SUBSCRIPTION s CONNECTION 'host=db user=rep password=${SECRET} dbname=d' PUBLICATION p`,
    'literal',
  ],
  [`ALTER SUBSCRIPTION s CONNECTION 'host=db password=''${SECRET}'''`, 'literal'],
  // Key and value pairs, JSON members.
  [`INSERT INTO cfg (body) VALUES ('{"password": "${SECRET}", "user": "u"}')`, 'literal'],
  [`INSERT INTO cfg (body) VALUES ('{"client_secret":"${SECRET}"}')`, 'literal'],
  [`INSERT INTO cfg (body) VALUES ('api_key=${SECRET}&x=1')`, 'literal'],
  [`UPDATE users SET password = '${SECRET}' WHERE id = 1`, 'literal'],
  [`UPDATE users SET password_hash = '${SECRET}' WHERE id = 1`, 'literal'],
  [`SELECT * FROM users WHERE reset_token = '${SECRET}'`, 'literal'],
  [`SELECT * FROM users WHERE token='it''s ${SECRET}'`, 'literal'],
  [`SELECT * FROM users WHERE token = E'it\\'s ${SECRET}'`, 'literal'],
  [`SELECT * FROM users WHERE token = $q$${SECRET}$q$`, 'literal'],
  [`SELECT f(password => '${SECRET}')`, 'literal'],
  [`SELECT * FROM t WHERE note = 'password: ${SECRET}'`, 'literal'],
  [`SELECT * FROM t WHERE access_token = '${SECRET}`, 'literal'],
  // Functions that take or hash a secret.
  [`SELECT crypt('${SECRET}', gen_salt('bf'))`, 'literal'],
  [`SELECT * FROM users WHERE pw = crypt('${SECRET}', pw)`, 'literal'],
  [`SELECT pgp_sym_encrypt('data', '${SECRET}')`, 'literal'],
  [`SELECT pgp_sym_decrypt(body, '${SECRET}', 'cipher-algo=aes256') FROM t`, 'literal'],
  [`SELECT public.pgp_sym_decrypt(body, '${SECRET}') FROM t`, 'literal'],
  [`SELECT "pgp_sym_decrypt"(body, '${SECRET}') FROM t`, 'literal'],
  [`SELECT pgp_pub_decrypt(body, dearmor('${SECRET}'), '${SECRET}') FROM t`, 'literal'],
  [`SELECT encrypt('data', '${SECRET}', 'aes')`, 'literal'],
  [`SELECT decrypt_iv(body, '${SECRET}', 'iv', 'aes') FROM t`, 'literal'],
  [`SELECT hmac('data', '${SECRET}', 'sha256')`, 'literal'],
  [`SELECT digest('${SECRET}', 'sha256')`, 'literal'],
  [`SELECT md5('${SECRET}' || 'app')`, 'literal'],
  [`SELECT sha256('${SECRET}'::bytea)`, 'literal'],
  [`SELECT crypt /* c */ ( E'${SECRET}', 'x')`, 'literal'],
  // A backslash before the quote: under standard_conforming_strings = off the literal runs on.
  [`SELECT crypt('C:\\', '${SECRET}')`, 'literal'],
  // Token and key formats of the log denylist.
  [`SELECT * FROM t WHERE h = 'Bearer abcdefghijklmnop${SECRET}'`, 'literal'],
  [`SELECT 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ${SECRET}.c2ln'`, 'literal'],
  [`SELECT 'exat_${SECRET}abcdef'`, 'literal'],
  [`SELECT 'ghp_${SECRET}abcdefghijklmnopqrstu'`, 'literal'],
  [`SELECT 'sk-ant-${SECRET}abcdefghijklmnop'`, 'literal'],
  [`SELECT 'AKIA${'A'.repeat(5)}${SECRET.toUpperCase()}'`, 'literal'],
  [`SELECT '${BEGIN}PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----'`, 'literal'],
  [`SELECT '${BEGIN}RSA PRIVATE KEY-----\n${SECRET}`, 'literal'],
  [`SELECT 'otpauth://totp/x?secret=${SECRET}'`, 'literal'],
  // In a comment.
  [`SELECT 1 /* password=${SECRET} */`, 'literal'],
  [`SELECT 1 -- ${PG}u:${SECRET}@h/d`, 'literal'],
]

describe('the raw statement view removes secrets', () => {
  for (const major of SUPPORTED_MAJORS) {
    for (const [text, mode] of SECRETS) {
      it(`PG${major}: ${text.slice(0, 70)}`, () => {
        const r = reveal(text, major)
        expect(r.text).not.toContain(SECRET)
        expect(r.text).not.toContain(SECRET.toUpperCase())
        expect(r.mode).toBe(mode)
        // The digest is the redacted form's: the one the sessions list shows.
        expect(r.digest).toBe(redactStatementSync(text, { major }).digest)
        if (mode === 'literal') {
          expect(r.removed).toBeGreaterThan(0)
          expect(r.text).toContain(REDACTED)
        } else {
          expect(r.removed).toBe(0)
        }
      })
    }
  }
})

/** Statements without a secret: the text comes back exactly as it was read. */
const PLAIN: readonly string[] = [
  `SELECT * FROM users WHERE email = 'ada@example.com' AND id = 42`,
  `INSERT INTO orders (id, note, at) VALUES (7, 'call back at 12:00:00', '2026-10-13 10:11:12+00')`,
  `UPDATE accounts SET balance = balance - 100.50 WHERE id = $1`,
  `SELECT 'it''s', E'tab\\there', $$dollar 'quoted'$$, B'1010', X'FF', U&'d\\0061t'`,
  `SELECT a::text, b::int FROM t WHERE c = ANY('{1,2,3}'::int[])`,
  `SELECT jsonb_build_object('name', 'ada', 'role', 'admin')`,
  `SELECT * FROM t WHERE host = '10.1.2.3' AND ip = '2001:db8::1'`,
  `/* a comment */ SELECT 1 -- trailing`,
  `SELECT pg_sleep(1), now(), current_user`,
  `SELECT count(*) FROM pg_stat_activity WHERE state = 'active'`,
  `CREATE INDEX CONCURRENTLY i ON t (lower(email))`,
  `SELECT 'Grüße, 🎉 emoji', 'ünïcödé'`,
  `SELECT * FROM t WHERE note = 'cut at track_activity_query_siz`,
  `SELECT digestion, md5sum, crypto FROM t WHERE passed = true`,
]

describe('nothing else is changed', () => {
  for (const major of SUPPORTED_MAJORS) {
    for (const text of PLAIN) {
      it(`PG${major}: ${text.slice(0, 70)}`, () => {
        const r = reveal(text, major)
        expect(r).toMatchObject({ text, mode: 'literal', removed: 0, truncated: false })
        expect(secretSpans(text)).toEqual([])
      })
    }
  }

  it('keeps the statement around a removed span', () => {
    const r = reveal(
      `SELECT * FROM dblink('host=db user=u password=${SECRET} dbname=d', 'SELECT 1') AS t(a int)`,
    )
    expect(r.text).toBe(
      `SELECT * FROM dblink('host=db user=u password=${REDACTED} dbname=d', 'SELECT 1') AS t(a int)`,
    )
    expect(reveal(`SELECT pgp_sym_encrypt('data', '${SECRET}'), 'kept'`).text).toBe(
      `SELECT pgp_sym_encrypt(${REDACTED}, ${REDACTED}), 'kept'`,
    )
    expect(reveal(`SELECT * FROM users WHERE token = '${SECRET}' AND id = 1`).text).toBe(
      `SELECT * FROM users WHERE token = ${REDACTED} AND id = 1`,
    )
    expect(reveal(`SELECT '${PG}app:${SECRET}@db/d'`).text).toBe(
      `SELECT '${PG}app:${REDACTED}@db/d'`,
    )
  })

  it('names the functions it treats as secret-bearing', () => {
    expect([...SECRET_FUNCTIONS]).toEqual(
      expect.arrayContaining(['crypt', 'pgp_sym_decrypt', 'hmac', 'dblink_connect', 'md5']),
    )
  })
})

describe('bounds', () => {
  it('caps at 64 KiB by default with truncated, never splitting a surrogate pair', () => {
    const long = `SELECT '${'a'.repeat(RAW_MAX_LENGTH + 10)}'`
    const r = reveal(long)
    expect(r.text.length).toBe(RAW_MAX_LENGTH)
    expect(r.truncated).toBe(true)
    expect(r.digest).toBe(redactStatementSync(long, { major: 17 }).digest)
    const emoji = `SELECT '${'🎉'.repeat(10)}'`
    // "SELECT '" is 8 code units; the 9th is the first half of the first emoji.
    const cut = reveal(emoji, 17, 9)
    expect(cut.truncated).toBe(true)
    expect(cut.text.isWellFormed()).toBe(true)
    expect(cut.text).toBe("SELECT '")
  })

  it('stays linear on adversarial key runs', () => {
    const runs = [
      'password-'.repeat(20_000),
      'a.'.repeat(50_000),
      `'${"''".repeat(50_000)}`,
      `x token=${'a'.repeat(100_000)}`,
    ]
    // Each run takes well under 200 ms alone (2026-10-13, about 150 ms for the largest); a
    // quadratic pattern on these 100,000-character inputs takes minutes. The bound is wide so
    // the test stays meaningful on a machine loaded by parallel suites (it measured 2,016 ms
    // once in a full parallel run with a 2,000 ms bound).
    for (const text of runs) {
      const started = performance.now()
      reveal(`SELECT ${text}`)
      expect(performance.now() - started).toBeLessThan(10_000)
    }
  })

  it('returns the unparseable marker for text that is not well-formed Unicode', () => {
    const r = reveal(`SELECT '${SECRET}\ud800'`)
    expect(r.mode).toBe('unparseable')
    expect(r.text).not.toContain(SECRET)
  })
})

describe('property: a password in a conninfo or URI never survives', () => {
  const secret = fc.stringMatching(/^[A-Za-z0-9!#%*+./=?^_{|}~-]{6,24}$/)
  it('conninfo', () => {
    fc.assert(
      fc.property(secret, (s) => {
        const text = `SELECT * FROM dblink('host=db password=${s} dbname=d', 'SELECT 1') AS t(a int)`
        expect(reveal(text).text).not.toContain(`password=${s}`)
      }),
      { numRuns: 200 },
    )
  })
  it('URI', () => {
    fc.assert(
      fc.property(secret, (s) => {
        const text = `SELECT '${PG}app:${s}@db.example.test/d'`
        expect(reveal(text).text).not.toContain(`:${s}@`)
      }),
      { numRuns: 200 },
    )
  })
})
