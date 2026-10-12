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
