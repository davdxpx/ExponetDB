import { beforeAll, describe, expect, it } from 'vitest'
import {
  countTokens,
  exceedsParseWork,
  legacyReferences,
  loadClusterGlobalParsers,
  MAX_PARSE_TOKENS,
  outsideScope,
  parsePlpgsql,
  parseWith,
  statementBodies,
} from '../src/parser/index.ts'

/**
 * What a legacy history references outside the managed scope
 * (legacy-import.md §2.5, follow-up 2 F3): the objects a scratch target
 * must hold before the replay reaches the file that names them, read from
 * the parse trees on 16, 17 and 18.
 */
beforeAll(async () => {
  await Promise.all([16, 17, 18].map((m) => loadClusterGlobalParsers(m as 16 | 17 | 18)))
})

const PUBLIC = { includeSchemas: ['public'], excludeSchemas: [] }
const refs = (files: readonly [string, string][], major: 16 | 17 | 18 = 17, scope = PUBLIC) =>
  legacyReferences(
    major,
    files.map(([name, text]) => ({ name, text })),
    scope,
  )

describe('legacyReferences', () => {
  it('names the identity function a policy calls, as on the first real import, on 16, 17 and 18', () => {
    for (const major of [16, 17, 18] as const) {
      const r = refs(
        [
          [
            '0013_tenant_members_own_read.sql',
            `CREATE POLICY acme_members_own_read ON public.acme_tenant_members
               FOR SELECT USING (user_id = (SELECT auth.uid()));`,
          ],
        ],
        major,
      )
      expect(r).toEqual({
        references: [
          { kind: 'function', schema: 'auth', name: 'uid', file: '0013_tenant_members_own_read' },
        ],
        unparsed: [],
        tooComplex: false,
      })
    }
  })

  it('reads relations, types, triggers, grants, SQL function bodies and DO blocks', () => {
    const r = refs([
      [
        '0001_profiles.sql',
        `CREATE TABLE public.acme_profiles (
           id uuid PRIMARY KEY REFERENCES auth.users (id),
           kind acme_identity.account_kind NOT NULL,
           tags extensions.citext[]
         );
         CREATE INDEX acme_profiles_kind ON public.acme_profiles (kind);
         GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;`,
      ],
      [
        '0002_triggers.sql',
        `CREATE FUNCTION public.acme_handle() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN PERFORM vault.never_read(); RETURN NEW; END $$;
         CREATE TRIGGER acme_on_signup AFTER INSERT ON auth.users
           FOR EACH ROW EXECUTE FUNCTION public.acme_handle();
         CREATE FUNCTION public.acme_me() RETURNS uuid LANGUAGE sql STABLE AS
           'SELECT auth.uid()';`,
      ],
      [
        '0003_do.sql',
        `DO $$ BEGIN
           IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'avatars') THEN
             UPDATE storage.buckets SET public = true WHERE id = 'avatars';
           END IF;
           PERFORM extensions.uuid_generate_v4();
         END $$;`,
      ],
    ])
    expect(r.unparsed).toEqual([])
    expect(r.references).toEqual([
      { kind: 'relation', schema: 'auth', name: 'users', file: '0001_profiles' },
      { kind: 'type', schema: 'acme_identity', name: 'account_kind', file: '0001_profiles' },
      { kind: 'type', schema: 'extensions', name: 'citext', file: '0001_profiles' },
      { kind: 'function', schema: 'auth', name: 'jwt', file: '0001_profiles' },
      // A PL/pgSQL function body runs only when called: vault.never_read is not needed.
      { kind: 'function', schema: 'auth', name: 'uid', file: '0002_triggers' },
      { kind: 'relation', schema: 'storage', name: 'buckets', file: '0003_do' },
      { kind: 'function', schema: 'extensions', name: 'uuid_generate_v4', file: '0003_do' },
    ])
  })

  it('leaves out what the history creates, what it drops, the scope and the system', () => {
    const r = refs([
      [
        '0001_own.sql',
        `CREATE SCHEMA acme_jobs;
         CREATE TABLE acme_jobs.queue (id bigint);
         CREATE TYPE acme_jobs.state AS ENUM ('new', 'done');
         CREATE FUNCTION acme_jobs.next() RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint';
         CREATE TABLE public.acme_t (id bigint, s acme_jobs.state, n pg_catalog.int4);`,
      ],
      [
        '0002_use.sql',
        `SELECT acme_jobs.next(); INSERT INTO acme_jobs.queue VALUES (1);
         DROP TABLE IF EXISTS legacy.old_things; DROP FUNCTION IF EXISTS legacy.old();
         SELECT public.acme_f(), information_schema._pg_truetypid(NULL, NULL);`,
      ],
      ['0003_notes.sql', '-- folded into 0002\n'],
    ])
    expect(r).toEqual({ references: [], unparsed: [], tooComplex: false })
  })

  it('names a file its grammar cannot read, and counts a schema only once per object', () => {
    const r = refs([
      ['0001_a.sql', 'SELECT auth.uid(); SELECT auth.uid();'],
      ['0002_b.sql', 'CREATE TABL public.broken (;'],
      ['0003_c.sql', 'SELECT auth.uid();'],
    ])
    expect(r).toEqual({
      references: [{ kind: 'function', schema: 'auth', name: 'uid', file: '0001_a' }],
      unparsed: ['0002_b'],
      tooComplex: false,
    })
  })

  it('follows a scope of excluded schemas', () => {
    const scope = { includeSchemas: null, excludeSchemas: ['auth'] }
    expect(outsideScope(scope, 'auth')).toBe(true)
    expect(outsideScope(scope, 'storage')).toBe(false)
    expect(outsideScope(scope, 'pg_catalog')).toBe(false)
    expect(outsideScope(PUBLIC, 'storage')).toBe(true)
    expect(outsideScope(PUBLIC, 'exponetdb')).toBe(false)
    const r = refs(
      [['0001.sql', 'SELECT auth.uid(), storage.foldername(NULL)']],
      17,
      scope as never,
    )
    expect(r.references.map((x) => `${x.schema}.${x.name}`)).toEqual(['auth.uid'])
  })

  it('follows nested bodies two levels deep, and says when a history nests deeper (security review)', () => {
    const nest = (depth: number): string => {
      let text = 'SELECT auth.uid()'
      for (let i = depth; i > 0; i--) {
        text = `CREATE FUNCTION public.acme_f${i}() RETURNS void LANGUAGE sql AS $t${i}$ ${text} $t${i}$`
      }
      return `${text};`
    }
    expect(refs([['0001.sql', nest(2)]])).toMatchObject({
      references: [{ kind: 'function', schema: 'auth', name: 'uid' }],
      tooComplex: false,
    })
    expect(refs([['0001.sql', nest(3)]])).toMatchObject({ references: [], tooComplex: true })
    // A deep nest is cut off quickly instead of exhausting the process.
    const started = Date.now()
    expect(refs([['0001.sql', nest(2000)]]).tooComplex).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('names what is used before the history creates it, CALL, COMMENT ON and schemas (review)', () => {
    const r = refs([
      ['0001_use.sql', 'SELECT acme_private.f(); CALL extensions.acme_proc();'],
      [
        '0002_create.sql',
        'CREATE SCHEMA acme_private; CREATE FUNCTION acme_private.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      ],
      [
        '0003_schemas.sql',
        `COMMENT ON TABLE auth.users IS 'people';
CREATE TABLE auth.acme_extra (id int);
GRANT USAGE ON SCHEMA storage TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA graphql GRANT SELECT ON TABLES TO authenticated;
SELECT acme_private.f();`,
      ],
    ])
    expect(r.references.map((x) => `${x.kind} ${x.schema}.${x.name} ${x.file}`)).toEqual([
      'function acme_private.f 0001_use',
      'function extensions.acme_proc 0001_use',
      'relation auth.users 0003_schemas',
      'schema auth.auth 0003_schemas',
      'schema storage.storage 0003_schemas',
      'schema graphql.graphql 0003_schemas',
    ])
  })
})

describe('what the scan cannot follow (the verification review of follow-up 2)', () => {
  it('reports a reference deeper than it follows as too complex, never as complete (P2-4)', () => {
    const deepIf = refs([
      [
        '0001_deep.sql',
        `DO $$ BEGIN ${'IF true THEN '.repeat(800)}PERFORM auth.uid();${' END IF;'.repeat(800)} END $$;`,
      ],
    ])
    expect(deepIf.tooComplex).toBe(true)
    const deepExpr = refs([['0001_deep.sql', `SELECT auth.uid()${'+1'.repeat(3000)};`]])
    expect(deepExpr.tooComplex).toBe(true)
    // At a depth it follows, the reference is found and the scan is complete.
    const shallow = refs([['0001_ok.sql', `SELECT auth.uid()${'+1'.repeat(10)};`]])
    expect([shallow.references.length, shallow.tooComplex]).toEqual([1, false])
  })

  it('gives the parser no more than its token budget, and says which file is too large (P1-1)', () => {
    const select = 'SELECT 1;'.repeat(Math.ceil(MAX_PARSE_TOKENS / 3) + 1)
    expect(countTokens(select, MAX_PARSE_TOKENS)).toBeGreaterThan(MAX_PARSE_TOKENS)
    expect(parseWith(17, select, 4 * 1024 * 1024)).toEqual({
      ok: false,
      failure: { kind: 'too_large' },
    })
    expect(exceedsParseWork(select)).toBe(true)
    // A body is one token to the SQL parser, and its own parse to the PL/pgSQL one.
    const body = `DO $$BEGIN ${'PERFORM 1;'.repeat(Math.ceil(MAX_PARSE_TOKENS / 3) + 1)} END$$;`
    expect(countTokens(body, MAX_PARSE_TOKENS)).toBeLessThan(10)
    expect(countTokens(body, MAX_PARSE_TOKENS, 'standard', true)).toBeGreaterThan(MAX_PARSE_TOKENS)
    expect(exceedsParseWork(body)).toBe(true)
    const r = refs([['0001_big.sql', body]])
    expect(r.tooComplex).toBe(true)
    // Many small bodies in one file are many small parses.
    const library = Array.from(
      { length: 2000 },
      (_, i) =>
        `CREATE FUNCTION public.f${i}() RETURNS int LANGUAGE sql AS $$ SELECT ${'1 + '.repeat(40)}1 $$;`,
    ).join('\n')
    expect(exceedsParseWork(library)).toBe(false)
  })

  describe('a single-quoted DO body gets the same token bound as a dollar-quoted one (TC-003, Part A P1 no. 1)', () => {
    const over = Math.ceil(MAX_PARSE_TOKENS / 3) + 1
    const block = (statements: number) => `BEGIN ${'PERFORM 1;'.repeat(statements)} END`
    const shapes = (statements: number): Record<string, string> => ({
      'DO ‹body›': `DO '${block(statements)}';`,
      'DO LANGUAGE x ‹body›': `DO LANGUAGE plpgsql '${block(statements)}';`,
      'DO ‹body› LANGUAGE x': `DO '${block(statements)}' LANGUAGE plpgsql;`,
      'DO E‹body›': `DO E'${block(statements)}';`,
    })

    for (const [shape, sql] of Object.entries(shapes(over))) {
      it(`refuses ${shape} above the budget, at every layer`, () => {
        expect(countTokens(sql, MAX_PARSE_TOKENS)).toBeLessThan(10)
        expect(countTokens(sql, MAX_PARSE_TOKENS, 'standard', true)).toBeGreaterThan(
          MAX_PARSE_TOKENS,
        )
        expect(exceedsParseWork(sql)).toBe(true)
        expect(parsePlpgsql(sql)).toBeUndefined()
        expect(refs([['0001_big.sql', sql]]).tooComplex).toBe(true)
      })
    }

    for (const [shape, sql] of Object.entries(shapes(1000))) {
      it(`still reads ${shape} with 1,000 statements`, () => {
        expect(exceedsParseWork(sql)).toBe(false)
        expect(parsePlpgsql(sql)).toBeDefined()
        expect(refs([['0001_ok.sql', sql]]).tooComplex).toBe(false)
      })
    }

    it('counts the body as PostgreSQL decodes it: doubled quotes, E escapes and continuations', () => {
      // `''` is one quote, `\040` is a space and `\x3b` a semicolon: the parser reads PERFORM 1; per unit.
      const unit = String.raw`PERFORM\0401\x3b`
      const escaped = `DO E'BEGIN ${unit.repeat(over)} END';`
      expect(exceedsParseWork(escaped)).toBe(true)
      const quotes = `DO 'BEGIN ${"PERFORM ''x'';".repeat(over)} END';`
      expect(exceedsParseWork(quotes)).toBe(true)
      const continued = `DO 'BEGIN ${'PERFORM 1;'.repeat(over)}'\n' END';`
      expect(exceedsParseWork(continued)).toBe(true)
      expect(statementBodies(String.raw`DO E'a\nb\'c\\d''e';`)).toEqual(["a\nb'c\\d'e"])
      expect(statementBodies(`DO 'a\\b';`)).toEqual(['a\\b'])
      expect(statementBodies(`DO 'a'\n'b';`)).toEqual(['ab'])
    })

    it('does not count an ordinary string literal as a body', () => {
      const json = JSON.stringify({ items: Array.from({ length: 60_000 }, (_, i) => `x${i}`) })
      expect(json.length).toBeGreaterThan(500_000)
      const insert = `INSERT INTO public.t (doc) VALUES ('${json.replaceAll("'", "''")}');`
      expect(exceedsParseWork(insert)).toBe(false)
      expect(statementBodies(insert)).toEqual([])
      const comment = `COMMENT ON TABLE public.t IS '${'word '.repeat(300_000)}';`
      expect(exceedsParseWork(comment)).toBe(false)
      // `AS` before a string is a function body; a string before `AS` is not.
      expect(statementBodies(`SELECT 'x' AS y;`)).toEqual([])
      expect(
        statementBodies(`CREATE FUNCTION f() RETURNS int AS 'SELECT 1' LANGUAGE sql;`),
      ).toEqual(['SELECT 1'])
    })
  })
})
