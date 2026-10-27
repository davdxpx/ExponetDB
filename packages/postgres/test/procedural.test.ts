import { beforeAll, describe, expect, it } from 'vitest'
import {
  analyzeMigrationSql,
  loadParser,
  mergeProceduralReasons,
  PROCEDURAL_REASONS,
  proceduralReasons,
} from '../src/parser/index.ts'
import { SUPPORTED_MAJORS } from '../src/versions.ts'

/**
 * OD-55 (c): which migration SQL is procedural, on every supported
 * grammar. A file the parser cannot read, or an empty list, counts as
 * procedural (`unclassified`): fail closed.
 */
beforeAll(async () => {
  for (const major of SUPPORTED_MAJORS) await loadParser(major)
})

function reasons(text: string, major: (typeof SUPPORTED_MAJORS)[number] = 17) {
  const r = analyzeMigrationSql(major, text)
  return proceduralReasons(r.ok ? r.statements : null)
}

describe('procedural classification (OD-55 (c))', () => {
  it.each(SUPPORTED_MAJORS)('classifies each procedural construct on PostgreSQL %i', (major) => {
    expect(reasons('DO $$ BEGIN NULL; END $$;', major)).toEqual(['do_block'])
    expect(reasons("DO $$ BEGIN EXECUTE format('SELECT %s', 1); END $$;", major)).toEqual([
      'do_block',
      'dynamic_sql',
    ])
    expect(reasons('CALL public.p();', major)).toEqual(['call'])
    expect(reasons('SELECT public.f();', major)).toEqual(['function_call'])
    expect(
      reasons('CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', major),
    ).toEqual(['routine_created'])
    expect(
      reasons(
        "CREATE FUNCTION public.g() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT 1'; END $$;",
        major,
      ),
    ).toEqual(['routine_created', 'dynamic_sql'])
    expect(
      reasons(
        'CREATE PROCEDURE public.p() LANGUAGE sql AS $$ SELECT 1 $$;\nCALL public.p();',
        major,
      ),
    ).toEqual(['call', 'routine_created'])
    expect(
      reasons(
        'CREATE TRIGGER t BEFORE INSERT ON public.items FOR EACH ROW EXECUTE FUNCTION public.f();',
        major,
      ),
    ).toEqual(['trigger_created'])
    expect(
      reasons(
        "INSERT INTO public.items SELECT 1 FROM pg_catalog.query_to_xml('SELECT 1', true, true, '') x;",
        major,
      ),
    ).toEqual(['dynamic_sql'])
    expect(reasons("SELECT * FROM dblink_exec('dbname=x', 'SELECT 1');", major)).toEqual([
      'function_call',
      'dynamic_sql',
    ])
  })

  it.each(SUPPORTED_MAJORS)(
    'counts statements that run a query, and rules, on PostgreSQL %i (review E-2, E-3)',
    (major) => {
      expect(reasons('CREATE TABLE public.copy AS SELECT public.f();', major)).toEqual([
        'function_call',
      ])
      expect(reasons('CREATE MATERIALIZED VIEW public.m AS SELECT public.f();', major)).toEqual([
        'function_call',
      ])
      expect(reasons('REFRESH MATERIALIZED VIEW public.m;', major)).toEqual(['function_call'])
      expect(
        reasons('CREATE RULE r AS ON INSERT TO public.items DO ALSO SELECT public.f();', major),
      ).toEqual(['trigger_created'])
    },
  )

  it('leaves plain DDL and DML alone, also with calls of existing functions in expressions', () => {
    expect(
      reasons(
        [
          'CREATE TABLE public.items (id uuid DEFAULT gen_random_uuid(), at timestamptz DEFAULT now());',
          'ALTER TABLE public.items ADD COLUMN note text;',
          'CREATE INDEX items_lower ON public.items (lower(note));',
          'INSERT INTO public.items (note) VALUES (upper($q$x$q$));',
          'GRANT SELECT ON public.items TO PUBLIC;',
          "COMMENT ON TABLE public.items IS 'EXECUTE is only a word here';",
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('counts unparsed or empty SQL as procedural (fail closed)', () => {
    expect(reasons('CREATE TABLE (;')).toEqual(['unclassified'])
    expect(proceduralReasons(null)).toEqual(['unclassified'])
    expect(proceduralReasons([])).toEqual(['unclassified'])
  })

  it('merges the reasons of several files in a fixed order, without repeats', () => {
    expect(
      mergeProceduralReasons([['dynamic_sql'], [], ['do_block', 'dynamic_sql'], ['unclassified']]),
    ).toEqual(['do_block', 'dynamic_sql', 'unclassified'])
    expect(mergeProceduralReasons([[], []])).toEqual([])
    expect(PROCEDURAL_REASONS).toEqual([
      'do_block',
      'call',
      'function_call',
      'routine_created',
      'trigger_created',
      'dynamic_sql',
      'unclassified',
    ])
  })
})
