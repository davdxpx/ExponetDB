import type { ProjectConfig } from '@exponetdb/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import type { BundleInput } from '../src/format/index.ts'
import {
  type CatalogFacts,
  type LintContext,
  type LintReport,
  lintBundles,
  prepareLint,
} from '../src/lint/index.ts'

/**
 * The V1 lint catalog (analysis.md §6) on the shared implementation the
 * CLI and the server run: findings carry a stable rule, level, blocking
 * flag, file and position; facts the linter does not have are reported
 * as unavailable, never assumed (G6 order §16).
 */
beforeAll(async () => {
  for (const major of [16, 17, 18] as const) await prepareLint(major)
})

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const PROJECT: ProjectConfig = {
  schema: 'exponetdb.project/v1',
  project: 'shop/platform',
  layout: 'bundles',
  defaults: { lockTimeout: '5s', statementTimeout: '15m', role: 'owner', searchPath: ['public'] },
  executionRoles: { owner: 'shop_owner' },
  managedScope: { includeSchemas: ['public'], excludeSchemas: [] },
  lintProfile: 'strict',
}

let counter = 0
function ulid(): string {
  counter++
  return `01JB2Z6G8M4Q7R9T1V3W5X${String(counter).padStart(4, '0')}`
}

interface Spec {
  readonly id?: string
  readonly name?: string
  readonly up: string
  readonly verify?: string | null
  readonly down?: string
  readonly dependsOn?: readonly string[]
  readonly transactional?: boolean
  readonly declared?: string
  readonly description?: string
  readonly extensions?: readonly string[]
  readonly lockTimeout?: string
}

function bundle(spec: Spec): BundleInput {
  const id = spec.id ?? ulid()
  const name = spec.name ?? 'change'
  const verify = spec.verify === undefined ? 'SELECT true AS ok;\n' : spec.verify
  const yaml = [
    'schema: exponetdb.migration/v1',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${JSON.stringify(spec.description ?? 'Adds what the lead inbox needs, tested on staging first.')}`,
    `dependsOn: ${JSON.stringify(spec.dependsOn ?? [])}`,
    'execution:',
    `  transactional: ${spec.transactional ?? true}`,
    ...(spec.lockTimeout === undefined ? [] : [`  lockTimeout: ${spec.lockTimeout}`]),
    ...(spec.extensions === undefined
      ? []
      : ['requires:', '  extensions:', ...spec.extensions.map((e) => `    - name: ${e}`)]),
    'compatibility:',
    `  declared: ${spec.declared ?? 'additive'}`,
    ...(spec.declared !== undefined && spec.declared !== 'additive' ? ['  notes: reviewed'] : []),
    'verification:',
    '  expectations: auto',
    `  runtimeChecks: ${verify === null ? 'none' : 'verify.sql'}`,
    ...(spec.down === undefined ? [] : ['rollback:', '  script: down.sql', '  safety: safe']),
    '',
  ].join('\n')
  const files = new Map<string, Uint8Array>([
    ['migration.yaml', utf8(yaml)],
    ['up.sql', utf8(spec.up)],
  ])
  if (verify !== null) files.set('verify.sql', utf8(verify))
  if (spec.down !== undefined) files.set('down.sql', utf8(spec.down))
  return { directory: `${id}_${name}`, files, projectDefaults: PROJECT.defaults }
}

function lint(bundles: BundleInput[], ctx: Partial<LintContext> = {}): LintReport {
  return lintBundles(bundles, { major: 17, project: PROJECT, tier: 'prod', ...ctx })
}

function rules(report: LintReport): string[] {
  return [...report.findings, ...report.bundles.flatMap((b) => b.findings)]
    .map((f) => f.rule)
    .sort()
}

function finding(report: LintReport, rule: string) {
  return [...report.findings, ...report.bundles.flatMap((b) => b.findings)].find(
    (f) => f.rule === rule,
  )
}

const TABLE =
  'CREATE TABLE public.lead (id bigint PRIMARY KEY, note text);\nGRANT SELECT ON public.lead TO app;\n'

describe('a clean additive bundle', () => {
  it('has digests, an analysis and no blocking finding', () => {
    const r = lint([bundle({ up: TABLE })])
    const b = r.bundles[0]
    expect(b?.valid).toBe(true)
    expect(b?.checksum).toMatch(/^sha256:c1:[0-9a-f]{64}$/)
    expect(b?.compatibility).toMatchObject({ declared: 'additive', observed: 'additive' })
    expect(b?.statements.map((s) => s.type)).toEqual(['CreateStmt', 'GrantStmt'])
    expect(r.blocking, JSON.stringify(rules(r))).toBe(false)
    expect(r.graph).toMatchObject({ valid: true, errors: [] })
  })
})

describe('content the engine refuses', () => {
  it('blocks a forbidden statement on every tier, with its position', () => {
    for (const tier of ['prod', 'nonprod'] as const) {
      const r = lint([bundle({ up: `${TABLE}SET ROLE postgres;\n` })], { tier })
      const f = finding(r, 'forbidden_statement')
      expect(f).toMatchObject({
        level: 'error',
        blocking: true,
        file: 'up.sql',
        statementIndex: 2,
        line: 3,
      })
    }
  })

  it('refuses CONCURRENTLY in a transactional bundle and a needless non-transactional one', () => {
    expect(
      finding(
        lint([bundle({ up: 'CREATE INDEX CONCURRENTLY i ON public.lead (note);' })]),
        'nontransactional_statement_in_transactional',
      )?.blocking,
    ).toBe(true)
    expect(
      finding(lint([bundle({ up: TABLE, transactional: false })]), 'needless_nontransactional')
        ?.blocking,
    ).toBe(true)
    const two = lint([
      bundle({
        up: 'CREATE INDEX CONCURRENTLY i ON public.lead (note);\nCREATE INDEX CONCURRENTLY j ON public.lead (id);',
        transactional: false,
      }),
    ])
    expect(finding(two, 'multiple_nontransactional_statements')?.level).toBe('warn')
  })

  it('refuses an enum value used in the transaction that adds it', () => {
    const r = lint([
      bundle({
        up: "ALTER TYPE public.mood ADD VALUE 'sad';\nUPDATE public.person SET mood = 'sad' WHERE id = 1;",
        declared: 'data_rewrite',
      }),
    ])
    expect(finding(r, 'enum_value_used_in_same_tx')).toMatchObject({
      blocking: true,
      statementIndex: 1,
    })
  })

  it('refuses SECURITY DEFINER without a pinned search_path', () => {
    const r = lint([
      bundle({
        up: 'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;',
      }),
    ])
    expect(finding(r, 'security_definer_without_search_path')?.blocking).toBe(true)
  })

  describe('server-file functions and untrusted languages (VC-146)', () => {
    const forbidden = (up: string) => finding(lint([bundle({ up })]), 'forbidden_statement')

    it.each([
      'pg_read_file',
      'pg_read_binary_file',
      'pg_ls_dir',
      'pg_stat_file',
      'lo_import',
      'lo_export',
    ])('refuses %s, qualified or not, in a statement and inside a body', (name) => {
      expect(forbidden(`SELECT ${name}('/etc/passwd');`), name).toMatchObject({ blocking: true })
      expect(
        forbidden(`SELECT pg_catalog.${name}('/etc/passwd');`),
        `pg_catalog.${name}`,
      ).toBeDefined()
      expect(forbidden(`SELECT "${name}"('/etc/passwd');`), `"${name}"`).toBeDefined()
      expect(
        forbidden(`DO $$ BEGIN PERFORM ${name.toUpperCase()}('/etc/passwd'); END $$;`),
        `DO ${name}`,
      ).toBeDefined()
      expect(
        forbidden(
          `CREATE FUNCTION public.f() RETURNS text LANGUAGE sql AS 'SELECT ${name}(''/x'')';`,
        ),
        `function ${name}`,
      ).toBeDefined()
    })

    it.each([
      'pg_ls_logdir',
      'pg_ls_waldir',
      'pg_ls_tmpdir',
      'pg_ls_archive_statusdir',
      'pg_file_write',
      'pg_file_rename',
      'pg_file_unlink',
    ])('refuses the server-file function %s too', (name) => {
      expect(forbidden(`SELECT ${name}('x');`), name).toMatchObject({ blocking: true })
    })

    it('decodes a Unicode-escaped function name before it compares', () => {
      expect(forbidden(`SELECT U&"pg_read_file"('/etc/passwd');`)).toBeDefined()
      expect(forbidden(`SELECT U&"pg\\005fread_file"('/etc/passwd');`)).toBeDefined()
      expect(forbidden(`SELECT U&"pg\\+00005fread_file"('/etc/passwd');`)).toBeDefined()
      expect(forbidden(`SELECT "pg_read_""file"('/etc/passwd');`)).toBeUndefined()
    })

    it.each([
      'plpython3u',
      'plpythonu',
      'plperlu',
      'pltclu',
      'c',
      'internal',
      'plr',
      'plsh',
      'plrust',
    ])('refuses the untrusted language %s in CREATE FUNCTION and DO', (language) => {
      expect(
        forbidden(`CREATE FUNCTION public.f() RETURNS int LANGUAGE ${language} AS 'x';`),
      ).toMatchObject({ blocking: true })
      if (!['c', 'internal'].includes(language)) {
        expect(forbidden(`DO LANGUAGE ${language} $$ x $$;`)).toMatchObject({ blocking: true })
      }
    })

    it('does not refuse the name in a comment, a string or an identifier that only contains it', () => {
      expect(forbidden(`-- pg_read_file('/x')\nSELECT 1;`)).toBeUndefined()
      expect(forbidden(`SELECT 'pg_read_file(' AS note;`)).toBeUndefined()
      expect(forbidden('SELECT my_pg_read_file_wrapper(1);')).toBeUndefined()
      expect(
        forbidden(
          'CREATE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;',
        ),
      ).toBeUndefined()
    })
  })

  it('shares one parse budget between the bundles of a request, named, and still lints the rest (VC-014)', () => {
    const small =
      'CREATE TABLE public.a (id bigint PRIMARY KEY);\nCREATE TABLE public.b (id bigint);\n'
    const r = lint(
      [
        bundle({ up: small }),
        bundle({ up: small.replace(/public\.a/, 'public.c').replace(/public\.b/, 'public.d') }),
      ],
      { parseTokenBudget: 30 },
    )
    const refused = r.bundles.flatMap((b) => b.findings).filter((f) => f.rule === 'parse_error')
    expect(refused).toHaveLength(1)
    expect(refused[0]?.message).toContain('request_tokens')
    expect(refused[0]?.blocking).toBe(true)
    // The bundle inside the budget was analysed.
    expect(r.bundles[0]?.statements.length).toBe(2)
    expect(r.bundles[1]?.statements.length).toBe(0)
  })

  it('counts a dense down.sql against the same request budget (the review of group E)', () => {
    const small = 'CREATE TABLE public.a (id bigint PRIMARY KEY);\n'
    const dense = 'SELECT 1;\n'.repeat(40)
    const r = lint([bundle({ up: small, down: dense })], { parseTokenBudget: 60 })
    const messages = r.bundles.flatMap((b) => b.findings).filter((f) => f.rule === 'parse_error')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ file: 'down.sql', blocking: true })
    expect(messages[0]?.message).toContain('request_tokens')
    expect(r.bundles[0]?.rollbackStatements.length).toBe(0)
    // Inside the budget it is analysed as before.
    const fits = lint([bundle({ up: small, down: 'DROP TABLE public.a;\n' })], {
      parseTokenBudget: 60,
    })
    expect(fits.bundles[0]?.rollbackStatements.length).toBe(1)
  })

  it('names the limit when block comments nest too deep, without parsing the file (VC-013)', () => {
    const depth = 40_000
    const started = performance.now()
    const r = lint([bundle({ up: `${'/*'.repeat(depth)}${'*/'.repeat(depth)}\nSELECT 1;` })])
    expect(performance.now() - started).toBeLessThan(2000)
    expect(finding(r, 'parse_error')).toMatchObject({ file: 'up.sql', blocking: true })
    expect(finding(r, 'parse_error')?.message).toContain('comment_depth')
  })

  it('reports a parse error with the grammar and the position', () => {
    const r = lint([bundle({ up: 'CREATE TABLE public.ok (id int);\nCREATE TABEL x (id int);' })])
    expect(finding(r, 'parse_error')).toMatchObject({ file: 'up.sql', line: 2, blocking: true })
  })
})

describe('the manifest against the content', () => {
  it('blocks an understated compatibility class', () => {
    const r = lint([bundle({ up: 'DROP TABLE public.old;' })], { tier: 'nonprod' })
    expect(finding(r, 'compatibility_understated')).toMatchObject({
      blocking: true,
      file: 'migration.yaml',
    })
    expect(r.bundles[0]?.compatibility.observed).toBe('destructive')
  })

  it('treats a missing verify.sql as blocking on production only', () => {
    expect(
      finding(lint([bundle({ up: TABLE, verify: null })]), 'missing_verify_sql')?.blocking,
    ).toBe(true)
    expect(
      finding(
        lint([bundle({ up: TABLE, verify: null })], { tier: 'nonprod' }),
        'missing_verify_sql',
      )?.blocking,
    ).toBe(false)
  })

  it('reports an undeclared extension, by its objects', () => {
    const up =
      'CREATE TABLE public.doc (id int, embedding vector(3));\nGRANT SELECT ON public.doc TO app;'
    expect(finding(lint([bundle({ up })]), 'extension_not_declared')).toMatchObject({
      factsUnavailable: true,
    })
    expect(
      finding(lint([bundle({ up, extensions: ['vector'] })]), 'extension_not_declared'),
    ).toBeUndefined()
  })

  it('warns about a long lock timeout', () => {
    expect(
      finding(lint([bundle({ up: TABLE, lockTimeout: '2m' })]), 'long_lock_timeout')?.level,
    ).toBe('warn')
  })
})

describe('the NOT NULL recipe and stable defaults on a large table (VC-030, VC-028)', () => {
  const large: CatalogFacts = {
    source: 'live',
    observedAt: '2026-10-12T00:00:00Z',
    relations: new Map([['public.lead', { relkind: 'r', bytes: 2 ** 31, rows: 10_000_000 }]]),
  }
  const check =
    'ALTER TABLE public.lead ADD CONSTRAINT lead_note_nn CHECK (note IS NOT NULL) NOT VALID;\n'
  const validate = 'ALTER TABLE public.lead VALIDATE CONSTRAINT lead_note_nn;\n'
  const setNotNull = 'ALTER TABLE public.lead ALTER COLUMN note SET NOT NULL;\n'

  it('lets SET NOT NULL pass after a validated CHECK (IS NOT NULL) of the same bundle', () => {
    const r = lint([bundle({ up: check + validate + setNotNull })], { catalog: large })
    expect(finding(r, 'unsafe_not_null')).toBeUndefined()
  })

  it('still blocks it without the CHECK, with a CHECK that was never validated, or on another column', () => {
    expect(
      finding(lint([bundle({ up: setNotNull })], { catalog: large }), 'unsafe_not_null'),
    ).toMatchObject({ blocking: true })
    expect(
      finding(lint([bundle({ up: check + setNotNull })], { catalog: large }), 'unsafe_not_null'),
    ).toMatchObject({ blocking: true })
    const other = 'ALTER TABLE public.lead ALTER COLUMN title SET NOT NULL;\n'
    expect(
      finding(
        lint([bundle({ up: check + validate + other })], { catalog: large }),
        'unsafe_not_null',
      ),
    ).toMatchObject({ blocking: true })
  })

  it('takes a validated CHECK added by an earlier bundle of the same request', () => {
    const first = bundle({ up: check + validate })
    const r = lint([first, bundle({ up: setNotNull })], { catalog: large })
    expect(finding(r, 'unsafe_not_null')).toBeUndefined()
  })

  it('takes a validated CHECK the target already has', () => {
    const proven: CatalogFacts = { ...large, provenNotNull: new Set(['public.lead.note']) }
    expect(
      finding(lint([bundle({ up: setNotNull })], { catalog: proven }), 'unsafe_not_null'),
    ).toBeUndefined()
  })

  it.each(['now()', 'current_timestamp', 'statement_timestamp()', 'transaction_timestamp()'])(
    'does not call the stable default %s a table rewrite',
    (expression) => {
      const r = lint(
        [
          bundle({
            up: `ALTER TABLE public.lead ADD COLUMN seen timestamptz NOT NULL DEFAULT ${expression};\n`,
          }),
        ],
        { catalog: large },
      )
      expect(finding(r, 'volatile_default_rewrite')).toBeUndefined()
      expect(r.bundles[0]?.compatibility.observed).toBe('additive')
    },
  )

  it.each(['clock_timestamp()', 'gen_random_uuid()', 'random()', 'timeofday()'])(
    'still calls the volatile default %s a table rewrite',
    (expression) => {
      const column = expression === 'gen_random_uuid()' ? 'uuid' : 'text'
      const r = lint(
        [
          bundle({
            up: `ALTER TABLE public.lead ADD COLUMN seen ${column} DEFAULT ${expression}::${column};\n`,
          }),
        ],
        { catalog: large },
      )
      expect(finding(r, 'volatile_default_rewrite'), expression).toBeDefined()
    },
  )
})

describe('an exclusive lock held across a slow statement (VC-032)', () => {
  const large: CatalogFacts = {
    source: 'live',
    observedAt: '2026-10-12T00:00:00Z',
    relations: new Map([['public.lead', { relkind: 'r', bytes: 2 ** 31, rows: 10_000_000 }]]),
  }
  const addColumn = 'ALTER TABLE public.lead ADD COLUMN flag boolean;\n'
  const backfill = 'UPDATE public.lead SET flag = false WHERE id > 0;\n'
  const validate = 'ALTER TABLE public.lead VALIDATE CONSTRAINT lead_c;\n'

  it('flags a backfill after an ACCESS EXCLUSIVE statement of the same transactional bundle', () => {
    const r = lint([bundle({ up: addColumn + backfill })], { catalog: large })
    expect(finding(r, 'lock_held_across_slow_statement')).toMatchObject({
      blocking: true,
      statementIndex: 1,
    })
  })

  it('flags a validation after one, and names the table', () => {
    const r = lint([bundle({ up: addColumn + validate })], { catalog: large })
    expect(finding(r, 'lock_held_across_slow_statement')?.message).toContain('public.lead')
  })

  it('stays clean when the statements are split into bundles, or the table is small', () => {
    expect(
      finding(
        lint([bundle({ up: addColumn }), bundle({ up: backfill })], { catalog: large }),
        'lock_held_across_slow_statement',
      ),
    ).toBeUndefined()
    const small: CatalogFacts = {
      ...large,
      relations: new Map([['public.lead', { relkind: 'r', bytes: 1024, rows: 10 }]]),
    }
    expect(
      finding(
        lint([bundle({ up: addColumn + backfill })], { catalog: small }),
        'lock_held_across_slow_statement',
      ),
    ).toBeUndefined()
  })

  it('does not flag a slow statement on another table', () => {
    const r = lint([bundle({ up: `${addColumn}UPDATE public.other SET x = 1 WHERE id > 0;\n` })], {
      catalog: large,
    })
    expect(finding(r, 'lock_held_across_slow_statement')).toBeUndefined()
  })
})

describe('lock risk with and without live catalog facts', () => {
  const catalog = (bytes: number): CatalogFacts => ({
    source: 'live',
    observedAt: '2026-10-12T00:00:00Z',
    relations: new Map([['public.lead', { relkind: 'r', bytes, rows: 10 }]]),
  })
  const up = 'CREATE INDEX lead_note_idx ON public.lead (note);'

  it('marks the size unknown offline and blocks on production (fail closed)', () => {
    const f = finding(lint([bundle({ up })]), 'create_index_without_concurrently')
    expect(f).toMatchObject({ factsUnavailable: true, blocking: true })
  })

  it('decides by the live size: small tables pass, non-trivial ones block on production', () => {
    expect(
      finding(
        lint([bundle({ up })], { catalog: catalog(1024) }),
        'create_index_without_concurrently',
      ),
    ).toBeUndefined()
    expect(
      finding(
        lint([bundle({ up })], { catalog: catalog(2 ** 31) }),
        'create_index_without_concurrently',
      ),
    ).toMatchObject({
      blocking: true,
      factsUnavailable: false,
    })
    expect(
      finding(
        lint([bundle({ up })], { catalog: catalog(2 ** 31), tier: 'nonprod' }),
        'create_index_without_concurrently',
      )?.blocking,
    ).toBe(false)
  })

  it('refuses CREATE INDEX CONCURRENTLY on a partitioned table', () => {
    const facts: CatalogFacts = {
      source: 'live',
      observedAt: '2026-10-12T00:00:00Z',
      relations: new Map([['public.events', { relkind: 'p', bytes: 0, rows: 0 }]]),
    }
    const r = lint(
      [bundle({ up: 'CREATE INDEX CONCURRENTLY i ON public.events (at);', transactional: false })],
      {
        catalog: facts,
      },
    )
    expect(finding(r, 'cic_on_partitioned_table')?.blocking).toBe(true)
  })
})

describe('verify.sql', () => {
  it('refuses a DO block and a check without ok', () => {
    expect(
      finding(
        lint([bundle({ up: TABLE, verify: 'DO $$ BEGIN END $$;' })]),
        'verify_statement_without_assertion',
      ),
    ).toBeDefined()
    expect(
      finding(
        lint([bundle({ up: TABLE, verify: 'SELECT 1 AS one;' })]),
        'verify_statement_without_assertion',
      ),
    ).toBeDefined()
  })

  // verification.md §4.2: a finding of a refused verify.sql carries the decided code: a
  // statement form is MIGRATION_STATEMENT_FORBIDDEN, anything else VERIFY_CONSTRUCT_UNSUPPORTED.
  it.each([
    ['DELETE', 'DELETE FROM public.lead;', 'MIGRATION_STATEMENT_FORBIDDEN'],
    ['INSERT', 'INSERT INTO public.lead (id) VALUES (1);', 'MIGRATION_STATEMENT_FORBIDDEN'],
    ['UPDATE', "UPDATE public.lead SET note = 'x';", 'MIGRATION_STATEMENT_FORBIDDEN'],
    ['SELECT INTO', 'SELECT true AS ok INTO public.lead2;', 'MIGRATION_STATEMENT_FORBIDDEN'],
    [
      'FOR UPDATE',
      'SELECT true AS ok FROM public.lead FOR UPDATE;',
      'MIGRATION_STATEMENT_FORBIDDEN',
    ],
    ['DO', 'DO $$ BEGIN PERFORM 1; END $$;', 'MIGRATION_STATEMENT_FORBIDDEN'],
    ['CALL', 'CALL public.p();', 'MIGRATION_STATEMENT_FORBIDDEN'],
    [
      'a function outside the allowlist',
      'SELECT pg_catalog.pg_sleep(1) IS NULL AS ok;',
      'VERIFY_CONSTRUCT_UNSUPPORTED',
    ],
    ['output columns', 'SELECT 1 AS n;', 'VERIFY_CONSTRUCT_UNSUPPORTED'],
    [
      'an unqualified relation',
      'SELECT count(*) > 0 AS ok FROM lead;',
      'VERIFY_CONSTRUCT_UNSUPPORTED',
    ],
  ])('puts the decided code on the finding for %s in verify.sql', (_label, sql, code) => {
    const report = lint([bundle({ up: TABLE, verify: `-- check: c\n${sql}\n` })])
    const found = [...report.findings, ...report.bundles.flatMap((b) => b.findings)].filter(
      (f) => f.file === 'verify.sql' && f.code !== undefined,
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ code, blocking: true, level: 'error' })
    expect(['verify_admission', 'verify_statement_without_assertion']).toContain(found[0]?.rule)
  })

  it('has no code on a finding that is not a verify.sql refusal', () => {
    const report = lint([
      bundle({ up: 'DROP TABLE public.lead;\n', verify: null, declared: 'destructive' }),
    ])
    const all = [...report.findings, ...report.bundles.flatMap((b) => b.findings)]
    expect(all.length).toBeGreaterThan(0)
    expect(all.filter((f) => f.code !== undefined)).toEqual([])
  })

  it('admits a declared consumer function and marks the bundle as consumer code', () => {
    const verify =
      "-- check: tenant isolation\n-- calls: public.visible_leads(uuid)\nSELECT count(*) = 0 AS ok FROM public.visible_leads('00000000-0000-0000-0000-000000000000');\n"
    const r = lint([bundle({ up: TABLE, verify })])
    expect(r.bundles[0]?.verify).toMatchObject({ admitted: true, consumerCode: true })
    expect(r.bundles[0]?.verify.checks[0]).toMatchObject({
      name: 'tenant isolation',
      calls: 'public.visible_leads(uuid)',
    })
    // Without the declaration the same check is refused.
    const undeclared = lint([
      bundle({ up: TABLE, verify: verify.replace('-- calls: public.visible_leads(uuid)\n', '') }),
    ])
    expect(finding(undeclared, 'verify_admission')).toBeDefined()
  })

  it('needs a covering check for a data change, or the statement stays uncovered', () => {
    const up = `${TABLE}UPDATE public.lead SET note = 'x' WHERE id = 1;\n`
    expect(
      finding(lint([bundle({ up, declared: 'data_rewrite' })]), 'uncovered_statement'),
    ).toMatchObject({
      statementIndex: 2,
      blocking: true,
    })
    const covered =
      '-- check: backfilled\n-- covers: 2\nSELECT count(*) = 0 AS ok FROM public.lead WHERE note IS NULL;\n'
    expect(
      finding(
        lint([bundle({ up, verify: covered, declared: 'data_rewrite' })]),
        'uncovered_statement',
      ),
    ).toBeUndefined()
  })
})

describe('the graph', () => {
  it('reports an unknown dependency and a cycle with their ids', () => {
    const a = ulid()
    const b = ulid()
    const unknown = lint([bundle({ id: a, up: TABLE, dependsOn: ['01JB2Z6G8M4Q7R9T1V3W5X9999'] })])
    expect(unknown.graph.valid).toBe(false)
    expect(finding(unknown, 'unknown_dependency')?.blocking).toBe(true)
    const cycle = lint([
      bundle({ id: a, up: TABLE, dependsOn: [b] }),
      bundle({
        id: b,
        up: 'CREATE TABLE public.x (id int);\nGRANT SELECT ON public.x TO app;',
        dependsOn: [a],
      }),
    ])
    expect(cycle.graph.errors[0]?.code).toBe('MIGRATION_DEPENDENCY_CYCLE')
    expect(finding(cycle, 'dependency_cycle')?.blocking).toBe(true)
  })

  it('finds two unordered migrations that touch the same table', () => {
    const base = ulid()
    const r = lint([
      bundle({ id: base, up: TABLE }),
      bundle({ up: 'ALTER TABLE public.lead ADD COLUMN a int;', dependsOn: [base] }),
      bundle({ up: 'ALTER TABLE public.lead ADD COLUMN b int;', dependsOn: [base] }),
    ])
    const overlaps = r.bundles
      .flatMap((x) => x.findings)
      .filter((f) => f.rule === 'parallel_object_overlap')
    expect(overlaps).toHaveLength(2)
    expect(overlaps[0]?.blocking).toBe(true)
    expect(r.graph.order[0]).toBe(base)
  })
})

describe('history and project settings', () => {
  it('reports a checksum mismatch, a comment-only change and a rename against the ledger', () => {
    const id = ulid()
    const applied = lint([bundle({ id, up: TABLE })]).bundles[0]
    const comment = lint([bundle({ id, name: 'renamed', up: `-- reviewed\n${TABLE}` })], {
      applied: new Map([
        [
          id,
          {
            checksum: applied?.checksum ?? '',
            name: 'change',
            sourceDigest: applied?.sourceDigest ?? null,
          },
        ],
      ]),
    })
    expect(rules(comment)).toEqual(
      expect.arrayContaining(['comment_only_change', 'renamed_applied_migration']),
    )
    expect(finding(comment, 'checksum_mismatch')).toBeUndefined()
    const changed = lint([bundle({ id, up: `${TABLE}CREATE TABLE public.extra (id int);` })], {
      applied: new Map([
        [id, { checksum: applied?.checksum ?? '', name: 'change', sourceDigest: null }],
      ]),
    })
    expect(finding(changed, 'checksum_mismatch')?.blocking).toBe(true)
  })

  it('applies project overrides, but never lowers a rule the engine enforces', () => {
    const project: ProjectConfig = {
      ...PROJECT,
      lint: {
        rules: { missing_verify_sql: 'warn', forbidden_statement: 'warn', made_up_rule: 'off' },
      },
    }
    const r = lintBundles([bundle({ up: `${TABLE}SET ROLE x;`, verify: null })], {
      major: 17,
      project,
      tier: 'prod',
    })
    expect(finding(r, 'missing_verify_sql')).toMatchObject({
      level: 'warn',
      blocking: false,
      lowered: { from: 'error', to: 'warn' },
    })
    expect(finding(r, 'forbidden_statement')).toMatchObject({ level: 'error', blocking: true })
    expect(r.overrides).toEqual(
      expect.arrayContaining([
        {
          rule: 'forbidden_statement',
          level: 'warn',
          applied: false,
          reason: 'enforced_by_engine',
        },
        { rule: 'made_up_rule', level: 'off', applied: false, reason: 'unknown_rule' },
      ]),
    )
  })

  it('enforces project invariants for new tables', () => {
    const project: ProjectConfig = { ...PROJECT, invariants: { rowSecurityRequired: ['public'] } }
    const r = lintBundles([bundle({ up: TABLE })], { major: 17, project, tier: 'nonprod' })
    expect(finding(r, 'table_without_rls')?.blocking).toBe(true)
    const ok = lintBundles(
      [bundle({ up: `${TABLE}ALTER TABLE public.lead ENABLE ROW LEVEL SECURITY;` })],
      {
        major: 17,
        project,
        tier: 'nonprod',
      },
    )
    expect(finding(ok, 'table_without_rls')).toBeUndefined()
  })
})

describe('invalid bundles', () => {
  it('reports the refusal without linting further', () => {
    const b = bundle({ up: TABLE })
    const files = new Map(b.files)
    files.set('notes.txt', utf8('x'))
    const r = lint([{ ...b, files }])
    expect(r.bundles[0]).toMatchObject({ valid: false, migrationId: null })
    expect(finding(r, 'parse_error')?.message).toContain('MIGRATION_BUNDLE_INVALID')
  })
})
