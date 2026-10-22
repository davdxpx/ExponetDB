import { describe, expect, it } from 'vitest'
import {
  recordsTheFile,
  statementSequence,
  statementsMatch,
  supabaseVersionTime,
} from '../src/legacy-evidence.ts'

/**
 * Content evidence of the legacy import on the shapes real ledgers hold
 * (Wave 9 order A2): one element with the whole file, comments stripped;
 * drizzle breakpoints; headers edited after apply; comments inside
 * function bodies. Pure: no database.
 */
const FILE = `-- 0042_listing_flags: added after the merge
CREATE TABLE public.flags (
  id bigint PRIMARY KEY, -- the flag
  name text NOT NULL /* unique per tenant */
);
--> statement-breakpoint
CREATE INDEX flags_name ON public.flags (name);
--> statement-breakpoint
CREATE FUNCTION public.flag_count() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- counts every flag
  RETURN (SELECT count(*) FROM public.flags);
END
$$;
`

/** What a real Supabase ledger holds: the whole file, comments outside bodies stripped. */
const STRIPPED_OUTSIDE = `CREATE TABLE public.flags (
  id bigint PRIMARY KEY,
  name text NOT NULL
);

CREATE INDEX flags_name ON public.flags (name);

CREATE FUNCTION public.flag_count() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- counts every flag
  RETURN (SELECT count(*) FROM public.flags);
END
$$;`

/** A stripper that also removed the comment inside the function body. */
const STRIPPED_EVERYWHERE = STRIPPED_OUTSIDE.replace('  -- counts every flag\n', '')

const PARSED = [
  `CREATE TABLE public.flags (
  id bigint PRIMARY KEY, -- the flag
  name text NOT NULL /* unique per tenant */
)`,
  'CREATE INDEX flags_name ON public.flags (name)',
  `CREATE FUNCTION public.flag_count() RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- counts every flag
  RETURN (SELECT count(*) FROM public.flags);
END
$$`,
]

describe('statement sequences', () => {
  it('match a one-element ledger entry with comments stripped against the file: medium', () => {
    expect(statementsMatch([STRIPPED_OUTSIDE], [PARSED], [FILE])).toEqual({
      strength: 'medium',
      how: 'statements_normalized',
    })
  })

  it('match a code body the stripper also removed comments from: medium, as the hosted connector does (F5)', () => {
    expect(statementsMatch([STRIPPED_EVERYWHERE], [PARSED], [FILE])).toEqual({
      strength: 'medium',
      how: 'statements_bodies',
    })
    // The connector's shape (follow-up 2, F5): every comment line and the blank lines of a
    // routine's body gone, the indentation as it was.
    const file = `CREATE OR REPLACE FUNCTION public.acme_touch()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Keeps updated_at current.

  NEW.updated_at := now();  -- the time of the change
  RETURN NEW;
END;
$fn$;`
    const applied = `CREATE OR REPLACE FUNCTION public.acme_touch()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$`
    expect(statementsMatch([applied], [[file]], [file])).toEqual({
      strength: 'medium',
      how: 'statements_bodies',
    })
    // A changed literal inside the body is another body.
    expect(
      statementsMatch([applied.replace('now()', "'now'::timestamptz")], [[file]], [file]),
    ).toBe(null)
  })

  it('match statement by statement as strong only when each is the same text', () => {
    const statements = [
      'CREATE INDEX flags_name ON public.flags (name)',
      'CREATE INDEX other ON public.flags (id)',
    ]
    // Ends trimmed and a final semicolon aside, byte for byte.
    expect(
      statementsMatch(
        [
          '  CREATE INDEX flags_name ON public.flags (name);',
          'CREATE INDEX other ON public.flags (id)\n',
        ],
        [statements],
        [statements.join(';\n')],
      ),
    ).toEqual({ strength: 'strong', how: 'statements' })
    // Whitespace that differs inside a statement is the normalized tier, no longer strong.
    expect(
      statementsMatch(
        [
          'CREATE INDEX flags_name   ON public.flags (name);',
          'CREATE INDEX other ON public.flags (id)',
        ],
        [statements],
        [statements.join(';\n')],
      ),
    ).toEqual({ strength: 'medium', how: 'statements_normalized' })
  })

  it('never treat whitespace that is data, or a line a comment ended, as equal (review round 1)', () => {
    // Inside a literal, whitespace is data: no tier matches.
    expect(
      statementsMatch(
        ["INSERT INTO t VALUES ('a b')"],
        [["INSERT INTO t VALUES ('a  b')"]],
        ["INSERT INTO t VALUES ('a  b');"],
      ),
    ).toBe(null)
    // A line comment folded into one line comments out what followed it.
    expect(
      statementsMatch(
        ['ALTER TABLE t ADD COLUMN a int -- , ADD COLUMN b int'],
        [['ALTER TABLE t ADD COLUMN a int --\n, ADD COLUMN b int']],
        ['ALTER TABLE t ADD COLUMN a int --\n, ADD COLUMN b int;'],
      ),
    ).toBe(null)
  })

  it('remove comments and whitespace only inside code bodies, never inside data (review round 1)', () => {
    // A dollar-quoted literal is data: `--` in it is not a comment.
    expect(
      statementsMatch(
        ['INSERT INTO t VALUES ($$a$$)'],
        [['INSERT INTO t VALUES ($$a--b$$)']],
        ['INSERT INTO t VALUES ($$a--b$$);'],
      ),
    ).toBe(null)
    // A body in another language keeps its whitespace (indentation is code in Python).
    const python =
      'CREATE FUNCTION f() RETURNS int LANGUAGE plpython3u AS $py$\nif x:\n    return 1\nreturn 2\n$py$'
    expect(
      statementsMatch(
        [
          'CREATE FUNCTION f() RETURNS int LANGUAGE plpython3u AS $py$ if x: return 1 return 2 $py$',
        ],
        [[python]],
        [`${python};`],
      ),
    ).toBe(null)
    // A dollar-quoted default before a routine's body is data (review round 2).
    const withDefault = (d: string) =>
      `CREATE FUNCTION f(a text DEFAULT $d$x -- ${d}$d$) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END $$`
    expect(
      statementsMatch([withDefault('one')], [[withDefault('two')]], [`${withDefault('two')};`]),
    ).toBe(null)
    // A DO block without LANGUAGE, and a plpgsql routine with LANGUAGE after the body, are code.
    for (const [stored, file] of [
      ['DO $$ BEGIN PERFORM 1; END $$', 'DO $$\nBEGIN\n  -- once\n  PERFORM 1;\nEND\n$$'],
      [
        'CREATE FUNCTION g() RETURNS void AS $$ BEGIN PERFORM 1; END $$ LANGUAGE plpgsql',
        'CREATE FUNCTION g() RETURNS void AS $$\nBEGIN\n  -- once\n  PERFORM 1;\nEND\n$$ LANGUAGE plpgsql',
      ],
    ] as const) {
      expect(statementsMatch([stored], [[file]], [`${file};`])).toEqual({
        strength: 'medium',
        how: 'statements_bodies',
      })
    }
  })

  it("never take a LANGUAGE inside a literal for the routine's language (security review)", () => {
    const python = (indent: string) => `CREATE FUNCTION public.acme_py(x int) RETURNS int AS $py$
if x > 1:
${indent}return 2
return 1
$py$ SET application_name = 'language sql' LANGUAGE plpython3u`
    // The two bodies differ in meaning by their indentation alone.
    expect(statementsMatch([python('    ')], [[python('')]], [`${python('')};`])).toBe(null)
    // A real LANGUAGE sql after the body, also after a literal, is still code.
    const sql = (body: string) =>
      `CREATE FUNCTION public.acme_s() RETURNS int SET application_name = 'x' AS $s$ ${body} $s$ LANGUAGE sql`
    expect(
      statementsMatch(
        [sql('SELECT 1')],
        [[sql('SELECT  1 -- one')]],
        [`${sql('SELECT  1 -- one')};`],
      ),
    ).toEqual({
      strength: 'medium',
      how: 'statements_bodies',
    })
  })

  it('never match a different executable text, an empty entry or unreadable text', () => {
    expect(statementsMatch([STRIPPED_OUTSIDE.replace('bigint', 'int')], [PARSED], [FILE])).toBe(
      null,
    )
    expect(statementsMatch([], [PARSED], [FILE])).toBe(null)
    expect(statementsMatch(["CREATE TABLE t (x text DEFAULT 'open"], [PARSED], [FILE])).toBe(null)
    // A body that differs in code, not only in comments, is no evidence at any tier.
    const changed = STRIPPED_EVERYWHERE.replace('count(*)', 'count(id)')
    expect(statementsMatch([changed], [PARSED], [FILE])).toBe(null)
  })

  it('ignore whitespace next to a statement separator and a missing final semicolon', () => {
    expect(
      statementSequence(['CREATE TABLE a (id int) ;CREATE TABLE b (id int)'], { bodies: false }),
    ).toBe(
      statementSequence(['CREATE TABLE a (id int);\n\nCREATE TABLE b (id int);\n'], {
        bodies: false,
      }),
    )
    expect(
      statementSequence(['CREATE TABLE a (id int)', 'CREATE TABLE b (id int);'], { bodies: false }),
    ).toBe('CREATE TABLE a (id int);CREATE TABLE b (id int);')
  })

  it('treat a semicolon or a comment marker inside a literal or a quoted name as data', () => {
    const a = statementSequence(["INSERT INTO t VALUES ('a ; b -- c')"], { bodies: false })
    expect(a).toBe("INSERT INTO t VALUES ('a ; b -- c');")
    expect(statementSequence(['SELECT 1 AS "x ; y"'], { bodies: false })).toBe(
      'SELECT 1 AS "x ; y";',
    )
    expect(statementSequence(["SELECT E'it\\'s ; ok'"], { bodies: false })).toBe(
      "SELECT E'it\\'s ; ok';",
    )
    // A comment-only file has no statements at all.
    expect(statementSequence(['-- nothing to do\n/* still nothing */\n'], { bodies: false })).toBe(
      '',
    )
  })

  it('compare a curated multi-file entry against the files in order', () => {
    const files = ['CREATE TABLE a (id int);\n', '-- second\nCREATE TABLE b (id int);\n']
    const entry = ['CREATE TABLE a (id int);\nCREATE TABLE b (id int);']
    expect(
      statementsMatch(entry, [['CREATE TABLE a (id int)'], ['CREATE TABLE b (id int)']], files),
    ).toEqual({ strength: 'medium', how: 'statements_normalized' })
    // Stored statement by statement, the entry matches the files one by one: strong.
    expect(
      statementsMatch(
        ['CREATE TABLE a (id int)', 'CREATE TABLE b (id int)'],
        [['CREATE TABLE a (id int)'], ['CREATE TABLE b (id int)']],
        files,
      ),
    ).toEqual({ strength: 'strong', how: 'statements' })
    expect(
      statementsMatch(
        entry,
        [['CREATE TABLE b (id int)'], ['CREATE TABLE a (id int)']],
        [...files].reverse(),
      ),
    ).toBe(null)
  })
})

describe('evidence strength and ledger times', () => {
  it('records a file by content or a curated alias, never by a name alone', () => {
    expect(recordsTheFile('strong')).toBe(true)
    expect(recordsTheFile('medium')).toBe(true)
    expect(recordsTheFile('low')).toBe(true)
    expect(recordsTheFile('curated')).toBe(true)
    expect(recordsTheFile('weak')).toBe(false)
    expect(recordsTheFile(null)).toBe(false)
  })

  it('reads a Supabase version as its UTC time, and nothing else', () => {
    expect(supabaseVersionTime('20261021180932')).toBe('2026-10-21T18:09:32.000Z')
    expect(supabaseVersionTime('0002')).toBe(null)
    expect(supabaseVersionTime('20261341180932')).toBe(null)
    expect(supabaseVersionTime('2026102118093')).toBe(null)
  })
})
