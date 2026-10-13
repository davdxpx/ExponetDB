import type { BundleFileName, MigrationManifest, ProjectConfig } from '@exponetdb/contracts'
import {
  admitVerifySync,
  analyzeMigrationSql,
  COMPATIBILITY_ORDER,
  type CompatibilityClass,
  type LockSeverity,
  loadParser,
  mostSevere,
  type ObjectRef,
  type StatementFacts,
  type SupportedMajor,
  type VerifyRefusalCode,
  verifyDirectives,
  worstSeverity,
} from '@exponetdb/postgres/parser'
import {
  type BundleInput,
  normalizeSqlSource,
  type ValidatedBundle,
  validateBundle,
} from '../format/index.ts'
import { buildGraph, type MigrationGraph } from '../graph/index.ts'
import { LINT_RULES, type LintLevel, type LintRule, type LintRuleId } from './rules.ts'

/**
 * The migration linter ([analysis.md §6](../../../../exponetdb-docs/04-migrations/analysis.md#6-linter)):
 * one implementation for the CLI (local, offline), CI and the server's
 * planner. Pure: the caller passes the bundles' bytes and, at the server,
 * live catalog facts marked as such; nothing here reads a file, the network
 * or a database. A fact the caller did not provide is reported as
 * unavailable, never assumed favourable (C-11, C-30).
 */

export type Tier = 'prod' | 'nonprod'

/** Catalog facts the server reads with the observer role at plan time (never offline). */
export interface CatalogFacts {
  readonly source: 'live'
  readonly observedAt: string
  /** `schema.name` → relation facts (null size: statistics missing). */
  readonly relations: ReadonlyMap<
    string,
    { readonly relkind: string; readonly bytes: number | null; readonly rows: number | null }
  >
  /** Schema-qualified function, type or operator class name → the extension that owns it. */
  readonly extensionObjects?: ReadonlyMap<string, string>
  /** `schema.table.column` with a validated `CHECK (column IS NOT NULL)`. */
  readonly provenNotNull?: ReadonlySet<string>
}

export interface AppliedRecord {
  readonly checksum: string
  readonly name: string
  readonly sourceDigest: string | null
}

export interface LintContext {
  readonly major: SupportedMajor
  /** The project configuration (parsed and validated); null when linting without one. */
  readonly project: ProjectConfig | null
  /** The target's tier; offline linting assumes production (the strictest). */
  readonly tier: Tier
  /** Stream nodes beyond the submitted bundles (bundle store, ledgers), with their dependencies. */
  readonly stream?: readonly { readonly id: string; readonly dependsOn: readonly string[] }[]
  readonly baselines?: readonly string[]
  /** What a target ledger (or the stream's ledgers) records per migration id. */
  readonly applied?: ReadonlyMap<string, AppliedRecord>
  /** Checksums the bundle store saw per migration id (never applied anywhere). */
  readonly ingested?: ReadonlyMap<string, readonly string[]>
  readonly catalog?: CatalogFacts
}

export interface LintFinding {
  readonly rule: LintRuleId
  readonly level: LintLevel
  readonly blocking: boolean
  readonly message: string
  readonly remediation: string
  readonly migrationId: string | null
  readonly file: BundleFileName | null
  readonly statementIndex: number | null
  readonly line: number | null
  readonly column: number | null
  /**
   * The catalog code of a `verify.sql` admission refusal (verification.md §4.2);
   * absent on every other finding.
   */
  readonly code?: VerifyRefusalCode
  /** A fact the rule needs was not available here (offline lint, missing statistics). */
  readonly factsUnavailable: boolean
  /** The project lowered the rule's level (shown in plans). */
  readonly lowered: { readonly from: LintLevel; readonly to: LintLevel } | null
}

export interface VerifyCheck {
  readonly index: number
  readonly name: string
  /** `-- covers:` entries: statement indexes of up.sql or object names. */
  readonly covers: readonly string[]
  /** `-- calls: schema.function(argtypes)`: declared consumer function. */
  readonly calls: string | null
  /** `-- reads-view: schema.view`: declared consumer view. */
  readonly readsView: string | null
}

export interface BundleReport {
  readonly directory: string
  readonly migrationId: string | null
  readonly name: string | null
  readonly valid: boolean
  readonly checksum: string | null
  readonly verifyDigest: string | null
  readonly rollbackDigest: string | null
  readonly bundleDigest: string | null
  readonly sourceDigest: string | null
  readonly manifest: MigrationManifest | null
  readonly canonicalManifest: Readonly<Record<string, unknown>> | null
  readonly dependsOn: readonly string[]
  readonly transactional: boolean | null
  /** The analysis of up.sql (empty when the bundle is invalid or does not parse). */
  readonly statements: readonly StatementFacts[]
  /** The analysis of down.sql, when present. */
  readonly rollbackStatements: readonly StatementFacts[]
  readonly compatibility: {
    readonly declared: CompatibilityClass | null
    readonly observed: CompatibilityClass
    readonly flags: readonly CompatibilityClass[]
  }
  readonly lockSeverity: LockSeverity
  readonly autocommitStatements: number
  readonly coverage: {
    readonly derived: number
    readonly partlyDerived: number
    readonly underived: number
    /** Statement indexes neither derived nor covered by a verify.sql check. */
    readonly uncovered: readonly number[]
  }
  readonly verify: {
    readonly present: boolean
    readonly admitted: boolean
    readonly checks: readonly VerifyCheck[]
    /** Declared consumer code: needs an explicit approval on every tier. */
    readonly consumerCode: boolean
  }
  readonly findings: readonly LintFinding[]
}

export interface LintReport {
  readonly major: SupportedMajor
  readonly tier: Tier
  readonly facts: 'offline' | 'live'
  readonly bundles: readonly BundleReport[]
  readonly graph: {
    readonly valid: boolean
    readonly errors: readonly { readonly code: string; readonly migrationIds: readonly string[] }[]
    /** Topological order of the stream (empty when the graph is invalid). */
    readonly order: readonly string[]
    readonly heads: readonly string[]
  }
  /** Findings not tied to one bundle (graph, overlaps are per bundle). */
  readonly findings: readonly LintFinding[]
  readonly overrides: readonly {
    readonly rule: string
    readonly level: string
    readonly applied: boolean
    readonly reason: string | null
  }[]
  readonly errors: number
  readonly warnings: number
  readonly blocking: boolean
}

/** Loads the parser of `major` (WASM, once per process). */
export function prepareLint(major: SupportedMajor): Promise<void> {
  return loadParser(major)
}

const DEFAULT_THRESHOLD = { bytes: 64 * 1024 * 1024, rows: 1_000_000 }

/** Rules `standard` reports as information (the `strict` profile keeps the catalog levels). */
const STANDARD_INFO: ReadonlySet<LintRuleId> = new Set([
  'function_search_path_mutable',
  'drop_without_expand_contract',
  'rename_in_place',
])

/** Common extension objects, for offline linting (the server adds the catalog's own). */
const KNOWN_EXTENSION_OBJECTS: ReadonlyMap<string, string> = new Map(
  (
    [
      [
        'vector',
        [
          'vector',
          'halfvec',
          'sparsevec',
          'l2_distance',
          'cosine_distance',
          'inner_product',
          'vector_l2_ops',
          'vector_cosine_ops',
          'vector_ip_ops',
        ],
      ],
      [
        'pg_trgm',
        [
          'similarity',
          'word_similarity',
          'strict_word_similarity',
          'show_trgm',
          'gin_trgm_ops',
          'gist_trgm_ops',
        ],
      ],
      ['citext', ['citext']],
      ['hstore', ['hstore']],
      ['ltree', ['ltree', 'lquery', 'ltxtquery']],
      [
        'pgcrypto',
        [
          'gen_salt',
          'crypt',
          'digest',
          'hmac',
          'pgp_sym_encrypt',
          'pgp_sym_decrypt',
          'armor',
          'dearmor',
        ],
      ],
      [
        'uuid-ossp',
        [
          'uuid_generate_v1',
          'uuid_generate_v1mc',
          'uuid_generate_v3',
          'uuid_generate_v4',
          'uuid_generate_v5',
        ],
      ],
      ['unaccent', ['unaccent']],
      [
        'postgis',
        ['geometry', 'geography', 'st_distance', 'st_intersects', 'st_makepoint', 'st_setsrid'],
      ],
      ['btree_gist', ['gist_int4_ops', 'gist_text_ops']],
    ] as const
  ).flatMap(([ext, objects]) => objects.map((o) => [o, ext] as const)),
)

function levelRank(level: LintLevel | 'off'): number {
  return level === 'error' ? 3 : level === 'warn' ? 2 : level === 'info' ? 1 : 0
}

interface Emitter {
  emit(
    rule: LintRuleId,
    message: string,
    at?: {
      readonly file?: BundleFileName | null
      readonly statement?: StatementFacts | null
      readonly line?: number | null
      readonly column?: number | null
      readonly large?: boolean | null
      readonly factsUnavailable?: boolean
      readonly code?: VerifyRefusalCode
    },
  ): void
}

class Rules {
  readonly #tier: Tier
  readonly #levels = new Map<LintRuleId, LintLevel | 'off'>()
  readonly overrides: LintReport['overrides'][number][] = []

  constructor(project: ProjectConfig | null, tier: Tier) {
    this.#tier = tier
    const standard = project?.lintProfile === 'standard'
    for (const [id, r] of Object.entries(LINT_RULES) as [LintRuleId, LintRule][]) {
      this.#levels.set(id, standard && STANDARD_INFO.has(id) ? 'info' : r.level)
    }
    for (const [id, level] of Object.entries(project?.lint?.rules ?? {})) {
      if (!Object.hasOwn(LINT_RULES, id)) {
        this.overrides.push({ rule: id, level, applied: false, reason: 'unknown_rule' })
        continue
      }
      const r = LINT_RULES[id as LintRuleId] as LintRule
      if (r.fixed && levelRank(level) < levelRank(r.level)) {
        this.overrides.push({ rule: id, level, applied: false, reason: 'enforced_by_engine' })
        continue
      }
      this.#levels.set(id as LintRuleId, level)
      this.overrides.push({ rule: id, level, applied: true, reason: null })
    }
  }

  emitter(migrationId: string | null, out: LintFinding[]): Emitter {
    return {
      emit: (id, message, at = {}) => {
        const r = LINT_RULES[id] as LintRule
        const level = this.#levels.get(id) ?? r.level
        if (level === 'off') return
        const lowered = levelRank(level) < levelRank(r.level) ? { from: r.level, to: level } : null
        const large = at.large ?? null
        const blocking =
          level === 'info' || (lowered !== null && level !== 'error')
            ? false
            : r.blocking === 'always'
              ? true
              : r.blocking === 'prod'
                ? this.#tier === 'prod'
                : r.blocking === 'prod_large'
                  ? this.#tier === 'prod' && large !== false
                  : false
        out.push({
          rule: id,
          level,
          blocking,
          message,
          remediation: r.remediation,
          migrationId,
          file: at.file ?? (at.statement !== undefined && at.statement !== null ? 'up.sql' : null),
          statementIndex: at.statement?.index ?? null,
          line: at.line ?? at.statement?.line ?? null,
          column: at.column ?? at.statement?.column ?? null,
          ...(at.code === undefined ? {} : { code: at.code }),
          factsUnavailable: at.factsUnavailable ?? (r.blocking === 'prod_large' && large === null),
          lowered,
        })
      },
    }
  }
}

function key(schema: string | null, name: string): string {
  return schema === null ? name : `${schema}.${name}`
}

/** The relation facts of a name as the migration resolves it (its search path). */
function relationFacts(
  catalog: CatalogFacts | undefined,
  ref: { readonly schema: string | null; readonly name: string },
  searchPath: readonly string[],
) {
  if (catalog === undefined) return undefined
  if (ref.schema !== null) return catalog.relations.get(key(ref.schema, ref.name))
  for (const schema of searchPath) {
    const facts = catalog.relations.get(key(schema, ref.name))
    if (facts !== undefined) return facts
  }
  return undefined
}

/**
 * Whether a table is non-trivial (analysis.md §3): true, false, or null
 * when the size is not known (offline, or statistics missing). A table
 * created by the same bundle is new and small.
 */
function isLarge(
  ctx: LintContext,
  ref: { readonly schema: string | null; readonly name: string },
  searchPath: readonly string[],
  createdHere: ReadonlySet<string>,
): boolean | null {
  if (createdHere.has(key(ref.schema, ref.name)) || createdHere.has(ref.name)) return false
  const facts = relationFacts(ctx.catalog, ref, searchPath)
  if (facts === undefined) return null
  const bytes = ctx.project?.lint?.sizeThreshold?.bytes ?? DEFAULT_THRESHOLD.bytes
  const rows = ctx.project?.lint?.sizeThreshold?.rows ?? DEFAULT_THRESHOLD.rows
  if (facts.bytes === null && facts.rows === null) return null
  return (facts.bytes ?? 0) > bytes || (facts.rows ?? 0) > rows
}

function tableOf(
  s: StatementFacts,
): { readonly schema: string | null; readonly name: string } | null {
  const lock = s.objects.find((o) => o.kind === 'table')
  if (lock !== undefined) return { schema: lock.schema, name: lock.name }
  const t = s.objects.find((o) => o.table !== undefined)?.table
  return t ?? null
}

/**
 * `-- check:`, `-- covers:`, `-- calls:`, `-- reads-view:` directives above
 * each verify statement: line comments between two statements, found by the
 * lexer (never inside a string, a dollar-quoted body or a statement).
 */
export function verifyChecks(major: SupportedMajor, text: string): VerifyCheck[] | undefined {
  return verifyDirectives(major, text)?.map((d) => ({
    index: d.index,
    name: d.name,
    covers: d.covers,
    calls: d.calls,
    readsView: d.readsView,
  }))
}

const FILE_REASONS: Readonly<Record<string, string>> = {
  invalid_directory_name: 'The directory name is not <ULID>_<name>.',
  unexpected_file: 'A file other than migration.yaml, up.sql, verify.sql and down.sql.',
  missing_file: 'A required file is missing.',
  file_too_large: 'A file exceeds its size limit (UTF-8 bytes).',
  invalid_utf8: 'A file is not valid UTF-8.',
  bom: 'A file starts with a byte order mark.',
  nul: 'A file contains a NUL character.',
  directory_mismatch: 'The directory name does not match the manifest id and name.',
  verify_file_mismatch: 'verify.sql and verification.runtimeChecks disagree.',
  rollback_file_mismatch: 'down.sql and rollback.script disagree.',
  empty_migration: 'up.sql is empty.',
  no_statements: 'up.sql holds only comments.',
}

/** Lints a set of bundles (one stream) for a target major and tier. */
export function lintBundles(inputs: readonly BundleInput[], ctx: LintContext): LintReport {
  const rules = new Rules(ctx.project, ctx.tier)
  const reports: BundleReport[] = []
  const graphFindings: LintFinding[] = []
  const validated: { report: BundleReport; bundle: ValidatedBundle; findings: LintFinding[] }[] = []
  const trusted = ctx.project?.trustedExtensions ?? []
  const forbiddenSchemas = new Set(ctx.project?.lint?.forbiddenSchemas ?? [])
  const forbiddenFunctions = new Set(ctx.project?.lint?.forbiddenFunctions ?? [])

  for (const input of inputs) {
    const findings: LintFinding[] = []
    const result = validateBundle(input)
    if (!result.ok) {
      const e = result.error
      const emitter = rules.emitter(null, findings)
      // A refused bundle is reported, never linted further.
      emitter.emit(
        'parse_error',
        e.code === 'MIGRATION_BUNDLE_INVALID'
          ? `${e.code}: ${FILE_REASONS[e.details.reason] ?? e.details.reason}`
          : `${e.code}: ${e.details.errors
              .map((x) => `${x.path} ${x.message}`)
              .join('; ')
              .slice(0, 900)}`,
        {
          file: e.code === 'MIGRATION_BUNDLE_INVALID' ? (e.details.file ?? null) : 'migration.yaml',
        },
      )
      reports.push(invalidReport(input.directory, findings))
      continue
    }
    const bundle = result.value
    const m = bundle.manifest
    const emit = rules.emitter(m.id, findings).emit
    const canonical = bundle.digests.canonicalManifest as {
      execution?: { searchPath?: string[]; lockTimeout?: number }
    }
    const searchPath = canonical.execution?.searchPath ?? []
    const up = normalizeSqlSource(input.files.get('up.sql') ?? new Uint8Array())
    const upText = up.ok ? up.value : ''
    const analysis = analyzeMigrationSql(ctx.major, upText, { trustedExtensions: trusted })
    let statements: readonly StatementFacts[] = []
    if (!analysis.ok) {
      emit(
        'parse_error',
        analysis.failure.kind === 'syntax'
          ? `up.sql does not parse with the PostgreSQL ${ctx.major} grammar${analysis.failure.resource ? ' (parser resource limit)' : ''}.`
          : `up.sql: ${analysis.failure.kind}.`,
        { file: 'up.sql', line: analysis.line, column: analysis.column },
      )
    } else {
      statements = analysis.statements
    }
    let rollbackStatements: readonly StatementFacts[] = []
    const downBytes = input.files.get('down.sql')
    if (downBytes !== undefined) {
      const down = normalizeSqlSource(downBytes)
      const downAnalysis = analyzeMigrationSql(ctx.major, down.ok ? down.value : '', {
        trustedExtensions: trusted,
      })
      if (!downAnalysis.ok) {
        emit('parse_error', `down.sql does not parse with the PostgreSQL ${ctx.major} grammar.`, {
          file: 'down.sql',
          line: downAnalysis.line,
          column: downAnalysis.column,
        })
      } else {
        rollbackStatements = downAnalysis.statements
        for (const s of downAnalysis.statements) {
          if (s.forbidden !== null) {
            emit(
              'forbidden_statement',
              `down.sql: ${s.kind} (${s.forbidden.reason}: ${s.forbidden.detail}).`,
              {
                file: 'down.sql',
                line: s.line,
                column: s.column,
              },
            )
          }
        }
      }
    }

    // ----- statements of up.sql -----
    const created = new Set<string>()
    for (const s of statements) {
      if (s.details.createdTable !== undefined) {
        created.add(key(s.details.createdTable.schema, s.details.createdTable.name))
        created.add(s.details.createdTable.name)
      }
    }
    const transactional = m.execution.transactional
    const autocommit = statements.filter((s) => s.autocommitOnly)
    for (const s of statements) {
      if (s.forbidden !== null) {
        emit('forbidden_statement', `${s.kind}: ${s.forbidden.reason} (${s.forbidden.detail}).`, {
          statement: s,
        })
      }
      if (s.autocommitOnly && transactional) {
        emit(
          'nontransactional_statement_in_transactional',
          `${s.kind} cannot run inside a transaction block.`,
          { statement: s },
        )
      }
      const table = tableOf(s)
      const large = table === null ? null : isLarge(ctx, table, searchPath, created)
      const create = s.details.createIndex
      if (create !== undefined && !create.concurrent) {
        const l = isLarge(ctx, create.table, searchPath, created)
        if (l !== false) {
          emit(
            'create_index_without_concurrently',
            `CREATE INDEX on ${key(create.table.schema, create.table.name)} blocks writes for the whole build${l === null ? ' (table size not known here)' : ''}.`,
            { statement: s, large: l },
          )
        }
      }
      if (create?.concurrent === true) {
        const facts = relationFacts(ctx.catalog, create.table, searchPath)
        const createdPartitioned = statements.some(
          (x) =>
            x.details.createdTable !== undefined &&
            key(x.details.createdTable.schema, x.details.createdTable.name) ===
              key(create.table.schema, create.table.name) &&
            x.expectations.some((e) => e.kind === 'relation' && e.relkinds.includes('p')),
        )
        if (facts?.relkind === 'p' || createdPartitioned) {
          emit(
            'cic_on_partitioned_table',
            `${key(create.table.schema, create.table.name)} is partitioned.`,
            {
              statement: s,
            },
          )
        }
      }
      for (const column of s.details.notNullWithoutProof ?? []) {
        const proven =
          table !== null &&
          (ctx.catalog?.provenNotNull?.has(
            `${key(table.schema ?? searchPath[0] ?? null, table.name)}.${column}`,
          ) ??
            false)
        if (!proven && large !== false) {
          emit(
            'unsafe_not_null',
            `SET NOT NULL on ${column} scans the table under ACCESS EXCLUSIVE.`,
            {
              statement: s,
              large,
            },
          )
        }
      }
      if (
        s.details.constraintValidated === true &&
        table !== null &&
        !created.has(key(table.schema, table.name)) &&
        large !== false
      ) {
        emit(
          'add_constraint_without_not_valid',
          `A validated constraint on ${key(table.schema, table.name)} scans it under lock.`,
          {
            statement: s,
            large,
          },
        )
      }
      if (s.details.volatileDefault === true && large !== false) {
        emit('volatile_default_rewrite', 'ADD COLUMN with a volatile default rewrites the table.', {
          statement: s,
          large,
        })
      }
      if (s.details.typeChange === true && large !== false) {
        emit(
          'type_change_rewrite',
          'ALTER COLUMN TYPE may rewrite the table and rebuild its indexes.',
          {
            statement: s,
            large,
          },
        )
      }
      if (s.details.unboundedDataChange === true) {
        emit('data_change_unbounded', `${s.kind} without a WHERE clause changes every row.`, {
          statement: s,
        })
      }
      if (
        s.details.dropColumn === true ||
        (s.type === 'DropStmt' && s.objects.some((o) => o.kind === 'table'))
      ) {
        emit(
          'drop_without_expand_contract',
          `${s.kind}: the running build may still use what is dropped.`,
          {
            statement: s,
          },
        )
      }
      if (s.details.rename === true) {
        emit('rename_in_place', 'A rename breaks code that uses the old name.', { statement: s })
      }
      if (s.details.functionCreated === true) {
        if (s.details.securityDefiner === true && s.details.searchPathSet !== true) {
          emit(
            'security_definer_without_search_path',
            'SECURITY DEFINER without SET search_path.',
            { statement: s },
          )
        } else if (s.details.searchPathSet !== true) {
          emit(
            'function_search_path_mutable',
            'The function resolves names with the caller search_path.',
            {
              statement: s,
            },
          )
        }
      }
      if (s.details.policyAlwaysTrue === true) {
        emit('policy_always_true', 'A write policy with USING (true) or WITH CHECK (true).', {
          statement: s,
        })
      }
      if (s.conditional) {
        emit('conditional_ddl', 'The DO block branches on catalog state.', { statement: s })
      }
      for (const name of s.details.referencedNames) {
        const [schema] = name.includes('.') ? name.split('.') : [null]
        if (schema !== null && schema !== undefined && forbiddenSchemas.has(schema)) {
          emit('forbidden_schema', `References the schema ${schema}.`, { statement: s })
        }
        const fn = name.split('.').pop() ?? name
        if (forbiddenFunctions.has(name) || forbiddenFunctions.has(fn)) {
          emit('forbidden_function', `Calls ${name}.`, { statement: s })
        }
      }
      for (const o of s.objects) {
        if (o.schema !== null && forbiddenSchemas.has(o.schema)) {
          emit('forbidden_schema', `Touches ${o.schema}.${o.name}.`, { statement: s })
        }
      }
    }
    // ADD VALUE then a use of the value in the same transaction.
    if (transactional) {
      for (const [i, s] of statements.entries()) {
        const added = s.details.enumValueAdded
        if (added === undefined) continue
        const user = statements
          .slice(i + 1)
          .find((later) => later.details.stringConstants.includes(added.value))
        if (user !== undefined) {
          emit(
            'enum_value_used_in_same_tx',
            `The value '${added.value.slice(0, 60)}' is added at statement ${i} and used at statement ${user.index}.`,
            { statement: user },
          )
        }
      }
    }
    // Extensions the SQL uses but the manifest does not declare.
    const declared = new Set((m.requires?.extensions ?? []).map((e) => e.name))
    const reported = new Set<string>()
    for (const s of statements) {
      for (const name of s.details.referencedNames) {
        const bare = name.split('.').pop() ?? name
        const ext =
          ctx.catalog?.extensionObjects?.get(name) ??
          KNOWN_EXTENSION_OBJECTS.get(bare.toLowerCase())
        if (
          ext !== undefined &&
          !declared.has(ext) &&
          !reported.has(ext) &&
          s.details.extensionCreated !== ext
        ) {
          reported.add(ext)
          emit('extension_not_declared', `${bare} belongs to the extension ${ext}.`, {
            statement: s,
            factsUnavailable: ctx.catalog?.extensionObjects === undefined,
          })
        }
      }
    }
    // Project invariants for new tables.
    const rlsSchemas = new Set(ctx.project?.invariants?.rowSecurityRequired ?? [])
    const grantSchemas = new Set(ctx.project?.invariants?.grantRequired ?? [])
    for (const s of statements) {
      const t = s.details.createdTable
      if (t === undefined) continue
      const schema = t.schema ?? searchPath[0] ?? null
      const same = (x: { schema: string | null; name: string } | undefined) =>
        x !== undefined && x.name === t.name && (x.schema ?? searchPath[0] ?? null) === schema
      if (
        schema !== null &&
        rlsSchemas.has(schema) &&
        !statements.some((x) => same(x.details.rlsEnabledOn))
      ) {
        emit(
          'table_without_rls',
          `${key(schema, t.name)} has no ENABLE ROW LEVEL SECURITY in this migration.`,
          {
            statement: s,
          },
        )
      }
      const granted = statements.some((x) => (x.details.grantOnTables ?? []).some((g) => same(g)))
      if (!granted && (grantSchemas.size === 0 || (schema !== null && grantSchemas.has(schema)))) {
        emit(
          'table_without_grant',
          `${key(schema, t.name)} has no explicit GRANT in this migration.`,
          {
            statement: s,
          },
        )
      }
    }
    // Transactional mode against the content.
    if (!transactional && statements.length > 0 && autocommit.length === 0) {
      emit('needless_nontransactional', 'No statement needs autocommit.', {
        file: 'migration.yaml',
      })
    }
    if (!transactional && statements.length > 1) {
      emit(
        'multiple_nontransactional_statements',
        `${statements.length} statements in a non-transactional bundle.`,
        {
          file: 'migration.yaml',
        },
      )
    }
    // The manifest.
    if (m.verification.runtimeChecks === 'none') {
      emit('missing_verify_sql', 'verification.runtimeChecks is none.', { file: 'migration.yaml' })
    }
    if (m.description.trim().length < 12) {
      emit('missing_description', 'The description is too short to say why the change exists.', {
        file: 'migration.yaml',
      })
    }
    if ((canonical.execution?.lockTimeout ?? 0) > 60_000) {
      emit(
        'long_lock_timeout',
        `lockTimeout is ${(canonical.execution?.lockTimeout ?? 0) / 1000} s.`,
        {
          file: 'migration.yaml',
        },
      )
    }
    const flags = [...new Set(statements.flatMap((s) => s.compatibility))]
    const observed = statements.length === 0 ? 'unknown' : mostSevere(flags)
    const declaredClass = m.compatibility.declared as CompatibilityClass
    if (observed === 'unknown') {
      emit(
        'compatibility_unknown',
        'At least one statement is not classified: the plan gates it as unknown.',
        {
          file: 'migration.yaml',
        },
      )
    } else {
      const d = COMPATIBILITY_ORDER.indexOf(declaredClass as (typeof COMPATIBILITY_ORDER)[number])
      const o = COMPATIBILITY_ORDER.indexOf(observed as (typeof COMPATIBILITY_ORDER)[number])
      if (d < o) {
        emit('compatibility_understated', `Declared ${declaredClass}, observed ${observed}.`, {
          file: 'migration.yaml',
        })
      } else if (d > o) {
        emit('declared_stricter_than_needed', `Declared ${declaredClass}, observed ${observed}.`, {
          file: 'migration.yaml',
        })
      }
    }
    const dupes = m.dependsOn.filter((x, i) => m.dependsOn.indexOf(x) !== i)
    if (dupes.length > 0) {
      emit(
        'duplicate_dependency',
        `dependsOn lists ${[...new Set(dupes)].join(', ')} more than once.`,
        {
          file: 'migration.yaml',
        },
      )
    }
    // History.
    const applied = ctx.applied?.get(m.id)
    if (applied !== undefined) {
      if (applied.checksum !== bundle.digests.checksum) {
        emit(
          'checksum_mismatch',
          `Applied as ${applied.checksum}; this content is ${bundle.digests.checksum}.`,
          {
            file: 'up.sql',
          },
        )
      } else if (
        applied.sourceDigest !== null &&
        applied.sourceDigest !== bundle.digests.sourceDigest
      ) {
        emit('comment_only_change', 'Comments or whitespace of up.sql changed since the apply.', {
          file: 'up.sql',
        })
      }
      if (applied.name !== m.name) {
        emit('renamed_applied_migration', `Applied as ${applied.name}.`, { file: 'migration.yaml' })
      }
    } else {
      const seen = ctx.ingested?.get(m.id)
      if (seen !== undefined && seen.length > 0 && !seen.includes(bundle.digests.checksum)) {
        emit('rewritten_unapplied_migration', 'The content changed since it was last ingested.', {
          file: 'up.sql',
        })
      }
    }
    // verify.sql: admission and directives.
    let checks: VerifyCheck[] = []
    let admitted = false
    const verifyText = bundle.digests.verifySource
    if (verifyText !== null) {
      checks = verifyChecks(ctx.major, verifyText) ?? []
      const declaredFunctions = new Set(
        checks.flatMap((c) => (c.calls === null ? [] : [c.calls.replace(/\(.*$/, '').trim()])),
      )
      const admission = admitVerifySync(ctx.major, verifyText, {
        extraFunctions: declaredFunctions,
      })
      admitted = admission.ok
      if (!admission.ok) {
        const reason = admission.reason
        emit(
          reason === 'output_columns' || reason === 'statement_class'
            ? 'verify_statement_without_assertion'
            : 'verify_admission',
          `verify.sql${admission.statement === undefined ? '' : ` check ${admission.statement}`}: ${reason}${admission.construct === undefined ? '' : ` (${admission.construct})`}.`,
          {
            file: 'verify.sql',
            // Always one of the two decided codes here: the data-read codes never name this refusal.
            ...(admission.code === 'MIGRATION_STATEMENT_FORBIDDEN' ||
            admission.code === 'VERIFY_CONSTRUCT_UNSUPPORTED'
              ? { code: admission.code }
              : {}),
          },
        )
      }
    }
    // Coverage: statements neither derived nor covered by a check.
    const covered = new Set<string>(checks.flatMap((c) => c.covers))
    const uncovered = statements
      .filter(
        (s) =>
          s.coverage !== 'derived' && !covered.has(String(s.index)) && !coveredByObject(s, covered),
      )
      .map((s) => s.index)
    for (const index of uncovered) {
      const s = statements[index] as StatementFacts
      emit(
        'uncovered_statement',
        `${s.kind}: not derivable and not covered by a verify.sql check.`,
        {
          statement: s,
        },
      )
    }
    const report: BundleReport = {
      directory: input.directory,
      migrationId: m.id,
      name: m.name,
      valid: true,
      checksum: bundle.digests.checksum,
      verifyDigest: bundle.digests.verifyDigest,
      rollbackDigest: bundle.digests.rollbackDigest,
      bundleDigest: bundle.digests.bundleDigest,
      sourceDigest: bundle.digests.sourceDigest,
      manifest: m,
      canonicalManifest: bundle.digests.canonicalManifest,
      dependsOn: [...new Set(m.dependsOn)].sort(),
      transactional,
      statements,
      rollbackStatements,
      compatibility: { declared: declaredClass, observed, flags },
      lockSeverity: worstSeverity(statements.flatMap((s) => s.locks.map((l) => l.severity))),
      autocommitStatements: autocommit.length,
      coverage: {
        derived: statements.filter((s) => s.coverage === 'derived').length,
        partlyDerived: statements.filter((s) => s.coverage === 'partly_derived').length,
        underived: statements.filter((s) => s.coverage === 'underived').length,
        uncovered,
      },
      verify: {
        present: verifyText !== null,
        admitted,
        checks,
        consumerCode: checks.some((c) => c.calls !== null || c.readsView !== null),
      },
      findings,
    }
    validated.push({ report, bundle, findings })
  }

  // ----- the graph over the submitted bundles and the known stream -----
  const ids = new Set<string>()
  const duplicates = new Set<string>()
  for (const v of validated) {
    if (ids.has(v.bundle.manifest.id)) duplicates.add(v.bundle.manifest.id)
    ids.add(v.bundle.manifest.id)
  }
  const graphErrors: { code: string; migrationIds: string[] }[] = []
  const graphEmit = rules.emitter(null, graphFindings).emit
  for (const id of duplicates) {
    graphErrors.push({ code: 'MIGRATION_BUNDLE_INVALID', migrationIds: [id] })
    graphEmit('duplicate_migration_id', `${id} is submitted twice.`)
  }
  let graph: MigrationGraph | undefined
  if (duplicates.size === 0) {
    const nodes = new Map<string, readonly string[]>()
    for (const s of ctx.stream ?? []) nodes.set(s.id, s.dependsOn)
    for (const v of validated) nodes.set(v.bundle.manifest.id, v.bundle.manifest.dependsOn)
    const built = buildGraph({
      migrations: [...nodes].map(([id, dependsOn]) => ({ id, dependsOn })),
      baselines: ctx.baselines ?? [],
    })
    if (built.ok) {
      graph = built.value
    } else {
      const e = built.error
      switch (e.code) {
        case 'unknown_dependency':
          graphErrors.push({
            code: 'MIGRATION_DEPENDENCY_UNKNOWN',
            migrationIds: [e.from, ...e.missing],
          })
          graphEmit(
            'unknown_dependency',
            `${e.from} depends on ${e.missing.join(', ')}, which the stream does not know.`,
          )
          break
        case 'cycle':
          graphErrors.push({ code: 'MIGRATION_DEPENDENCY_CYCLE', migrationIds: [...e.cycle] })
          graphEmit('dependency_cycle', `Cycle: ${e.cycle.join(' → ')}.`)
          break
        case 'unanchored_root':
          graphErrors.push({ code: 'MIGRATION_BUNDLE_INVALID', migrationIds: [e.id] })
          graphEmit('unanchored_root', `${e.id} has no dependsOn in a stream with a baseline.`)
          break
        case 'duplicate_id':
          graphErrors.push({ code: 'MIGRATION_BUNDLE_INVALID', migrationIds: [e.id] })
          graphEmit('duplicate_migration_id', `${e.id} appears twice in the stream.`)
          break
        default:
          graphErrors.push({
            code: 'MIGRATION_BUNDLE_INVALID',
            migrationIds: 'id' in e ? [e.id] : [e.from],
          })
          graphEmit('unknown_dependency', `Invalid graph node or reference (${e.code}).`)
      }
    }
  }

  // ----- unordered migrations touching the same object -----
  if (graph !== undefined) {
    const g = graph
    for (let i = 0; i < validated.length; i++) {
      for (let j = i + 1; j < validated.length; j++) {
        const a = validated[i]
        const b = validated[j]
        if (a === undefined || b === undefined) continue
        const ia = a.bundle.manifest.id
        const ib = b.bundle.manifest.id
        if (g.ancestors(ia).includes(ib) || g.ancestors(ib).includes(ia)) continue
        const shared = sharedObject(a.report.statements, b.report.statements, a.report, b.report)
        if (shared !== null) {
          rules
            .emitter(ia, a.findings)
            .emit(
              'parallel_object_overlap',
              `${ib} also touches ${shared}, with no order between them.`,
              {
                file: 'migration.yaml',
              },
            )
          rules
            .emitter(ib, b.findings)
            .emit(
              'parallel_object_overlap',
              `${ia} also touches ${shared}, with no order between them.`,
              {
                file: 'migration.yaml',
              },
            )
        }
      }
    }
  }

  for (const v of validated) reports.push(v.report)
  const all = [...graphFindings, ...reports.flatMap((r) => r.findings)]
  return {
    major: ctx.major,
    tier: ctx.tier,
    facts: ctx.catalog === undefined ? 'offline' : 'live',
    bundles: reports,
    graph: {
      valid: graph !== undefined,
      errors: graphErrors,
      order: graph === undefined ? [] : graph.order().filter((id) => ids.has(id)),
      heads: graph === undefined ? [] : graph.heads(),
    },
    findings: graphFindings,
    overrides: rules.overrides,
    errors: all.filter((f) => f.level === 'error').length,
    warnings: all.filter((f) => f.level === 'warn').length,
    blocking: all.some((f) => f.blocking),
  }
}

function coveredByObject(s: StatementFacts, covered: ReadonlySet<string>): boolean {
  return s.objects.some((o) => covered.has(o.name) || covered.has(key(o.schema, o.name)))
}

function objectKeys(
  statements: readonly StatementFacts[],
  searchPath: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>()
  const norm = (o: Pick<ObjectRef, 'schema' | 'name'>) =>
    key(o.schema ?? searchPath[0] ?? null, o.name)
  for (const s of statements) {
    for (const o of s.objects) {
      const k =
        o.table !== undefined
          ? `${o.kind}:${norm(o.table)}.${o.name}`
          : o.kind === 'function' || o.kind === 'procedure'
            ? `function:${norm(o)}`
            : `${o.kind === 'column' ? 'column' : o.kind === 'index' ? 'index' : o.kind === 'policy' ? 'policy' : 'relation'}:${norm(o)}`
      out.set(
        k,
        o.table !== undefined ? `${o.kind} ${norm(o.table)}.${o.name}` : `${o.kind} ${norm(o)}`,
      )
    }
  }
  return out
}

function sharedObject(
  a: readonly StatementFacts[],
  b: readonly StatementFacts[],
  ra: BundleReport,
  rb: BundleReport,
): string | null {
  const pathOf = (r: BundleReport) =>
    (r.canonicalManifest as { execution?: { searchPath?: string[] } } | null)?.execution
      ?.searchPath ?? []
  const ka = objectKeys(a, pathOf(ra))
  const kb = objectKeys(b, pathOf(rb))
  for (const [k, label] of ka) {
    if (kb.has(k)) return label
  }
  return null
}

function invalidReport(directory: string, findings: LintFinding[]): BundleReport {
  return {
    directory,
    migrationId: null,
    name: null,
    valid: false,
    checksum: null,
    verifyDigest: null,
    rollbackDigest: null,
    bundleDigest: null,
    sourceDigest: null,
    manifest: null,
    canonicalManifest: null,
    dependsOn: [],
    transactional: null,
    statements: [],
    rollbackStatements: [],
    compatibility: { declared: null, observed: 'unknown', flags: [] },
    lockSeverity: 'unknown',
    autocommitStatements: 0,
    coverage: { derived: 0, partlyDerived: 0, underived: 0, uncovered: [] },
    verify: { present: false, admitted: false, checks: [], consumerCode: false },
    findings,
  }
}
