import { dropDatabase, matrix, runAsSuperuser, superuserClient } from '@exponetdb/testkit'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  dollarQuote,
  ident,
  identifierTooLong,
  literal,
  quoteIdent,
  quoteLiteral,
  sql,
  type TargetSession,
} from '../src/index.ts'
import { open, prepareDatabase } from './targets.ts'

/**
 * sql-execution-security.md §5: hostile identifiers and literals never
 * break engine SQL. Every escaper round-trips through a live server, for
 * arbitrary text (quotes, backslashes, `$$`, newlines, Unicode), compared
 * with the server's own `quote_ident` and `quote_literal`.
 */
const text = fc
  .string({ unit: 'binary', minLength: 1, maxLength: 40 })
  .filter((s) => !s.includes('\u0000') && s.isWellFormed())

describe.each(matrix().map((s) => [s.major, s] as const))(
  'escaping on PostgreSQL %i',
  (_m, server) => {
    let db = ''
    let s: TargetSession

    beforeAll(async () => {
      db = await prepareDatabase(server, `esc_${server.major}`)
      s = await open(server, db, 'observer')
    })

    afterAll(async () => {
      await s.close()
      await dropDatabase(server, db)
    })

    it('round-trips literals', async () => {
      await fc.assert(
        fc.asyncProperty(text, async (value) => {
          const rows = await s.query(sql`SELECT ${literal(value)}::text AS v`)
          return rows[0]?.text('v') === value
        }),
        { numRuns: 150 },
      )
    })

    it('round-trips identifiers as output column names', async () => {
      await fc.assert(
        fc.asyncProperty(
          text.filter((v) => !identifierTooLong(v)),
          async (value) => {
            const rows = await s.query(sql`SELECT 1 AS ${ident(value)}`)
            return rows[0]?.has(value) === true
          },
        ),
        { numRuns: 150 },
      )
    })

    it('agrees with the server on what an identifier means', async () => {
      const client = await superuserClient(server, db)
      try {
        await fc.assert(
          fc.asyncProperty(
            text.filter((v) => !identifierTooLong(v)),
            async (value) => {
              const r = await client.query('SELECT quote_ident($1) AS q', [value])
              const server = r.rows[0]?.q as string
              // The server quotes only when needed; both forms must name the same thing.
              const ours = await client.query(`SELECT 1 AS ${quoteIdent(value)}`)
              const theirs = await client.query(`SELECT 1 AS ${server}`)
              return ours.fields[0]?.name === value && theirs.fields[0]?.name === value
            },
          ),
          { numRuns: 100 },
        )
      } finally {
        await client.end()
      }
    })

    it('creates hostile names in engine SQL without executing them', async () => {
      const names = ["x'||pg_sleep(3)::text||'", 'a"b', '$$', 'new\nline', 'select', 'back\\slash']
      for (const name of names) {
        await runAsSuperuser(server, db, [`CREATE TABLE public.${quoteIdent(name)} (id int)`])
      }
      const started = performance.now()
      for (const name of names) {
        const rows = await s.query(
          sql`SELECT c.relname::text AS name FROM pg_catalog.pg_class c
             WHERE c.relname = ${literal(name)} AND c.relnamespace = 'public'::regnamespace`,
        )
        expect(rows[0]?.text('name')).toBe(name)
      }
      expect(performance.now() - started).toBeLessThan(2000)
    })

    it('quotes literals with backslashes independent of standard_conforming_strings', async () => {
      const client = await superuserClient(server, db)
      try {
        for (const scs of ['on', 'off']) {
          await client.query(`SET standard_conforming_strings = ${scs}`)
          const value = "it's \\ a \\' test"
          const r = await client.query(`SELECT ${quoteLiteral(value)} AS v`)
          expect(r.rows[0]?.v).toBe(value)
        }
      } finally {
        await client.end()
      }
    })

    it('chooses a dollar-quote tag that the body does not contain', async () => {
      expect(dollarQuote('SELECT $$ x $a$', () => '00')).toBe('$exdb_00$SELECT $$ x $a$$exdb_00$')
      let draw = 0
      const retried = dollarQuote('x $exdb_a$ y', () => (draw++ === 0 ? 'a' : 'b'))
      expect(retried).toBe('$exdb_b$x $exdb_a$ y$exdb_b$')
    })
  },
)
