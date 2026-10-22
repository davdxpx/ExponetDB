import { beforeAll, describe, expect, it } from 'vitest'
import { legacyReferences, loadClusterGlobalParsers, outsideScope } from '../src/parser/index.ts'

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
