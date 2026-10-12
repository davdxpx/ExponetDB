import type { BundleReport, LintFinding } from '@exponetdb/migrations/lint'
import type { ConsumerCode, RelationSize, VerifyResolution } from '@exponetdb/postgres'
import {
  COMPATIBILITY_ORDER,
  type CompatibilityClass,
  type LockSeverity,
  mostSevere,
  type StatementFacts,
  type VerifyCheckSpec,
  worstSeverity,
} from '@exponetdb/postgres/parser'

/**
 * The plan's per-migration analysis ([planning-and-apply.md §2](../../../../exponetdb-docs/04-migrations/planning-and-apply.md#2-plan-content),
 * [analysis.md](../../../../exponetdb-docs/04-migrations/analysis.md)) from
 * the linter's report on the stored bytes, the live relation sizes and the
 * verify.sql catalog resolution. Statement text is never repeated here; the
 * analysis references statement indexes.
 */
function worst(flags: readonly CompatibilityClass[]): CompatibilityClass {
  if (flags.length === 0) return 'unknown'
  return mostSevere(flags)
}

function key(schema: string | null, name: string): string {
  return schema === null ? name : `${schema}.${name}`
}

export function statementAnalysis(s: StatementFacts) {
  const lock = s.locks.length === 0 ? null : s.locks
  return {
    index: s.index,
    line: s.line,
    kind: s.kind.slice(0, 64),
    transactional: !s.autocommitOnly,
    compatibility: worst(s.compatibility),
    lock:
      lock === null
        ? null
        : {
            mode: (
              lock.find((l) => l.severity === worstSeverity(lock.map((x) => x.severity)))?.mode ??
              lock[0]?.mode ??
              ''
            ).slice(0, 40),
            severity: worstSeverity(lock.map((l) => l.severity)),
            objects: [...new Set(lock.map((l) => l.on.slice(0, 300)))],
          },
    rewrite: s.rewrite,
    coverage: s.coverage,
    conditional: s.conditional || s.conditionalForm,
  }
}

export function lintEntry(f: LintFinding): LintEntry {
  return {
    rule: f.rule,
    level: f.level,
    blocking: f.blocking,
    message: f.message.slice(0, 1024),
    file: f.file,
    statementIndex: f.statementIndex,
    line: f.line,
    remediation: f.remediation === '' ? null : f.remediation.slice(0, 512),
  }
}

export interface LintEntry {
  readonly rule: string
  readonly level: 'error' | 'warn' | 'info'
  readonly blocking: boolean
  readonly message: string
  readonly file: 'migration.yaml' | 'up.sql' | 'verify.sql' | 'down.sql' | null
  readonly statementIndex: number | null
  readonly line: number | null
  readonly remediation: string | null
}

/** One migration's analysis (wire shape: `MigrationAnalysis`). */
export interface MigrationAnalysis {
  readonly migrationId: string
  readonly statements: readonly ReturnType<typeof statementAnalysis>[]
  readonly compatibility: {
    readonly declared: CompatibilityClass
    readonly observed: CompatibilityClass
    readonly agreement: boolean
  }
  readonly destructive: readonly string[]
  readonly lockSeverity: LockSeverity
  readonly rewriteRisk: readonly {
    readonly relation: string
    readonly bytes: number | null
    readonly rows: number | null
    readonly estimate: true
  }[]
  readonly rollback: { readonly available: boolean; readonly declaredSafety: string | null }
  readonly conditionalDdl: boolean
  readonly structuralExpectations: number
  readonly underivedStatements: number
  readonly verify: {
    readonly present: boolean
    readonly checks: readonly {
      readonly index: number
      readonly name: string
      readonly class: 'builtin' | 'consumer_code'
      readonly covers: readonly string[]
      readonly consumer: {
        readonly kind: 'function' | 'view'
        readonly identity: string
        readonly definitionDigest: string
        readonly securityDefiner: boolean
      } | null
    }[]
  }
  readonly lint: readonly LintEntry[]
}

export interface VerifyAnalysis {
  readonly checks: readonly VerifyCheckSpec[]
  readonly resolution: VerifyResolution | null
}

/** A refusal of the verify.sql catalog resolution, as a blocking finding of the plan. */
export function resolutionFinding(resolution: VerifyResolution): LintEntry | null {
  if (resolution.ok) return null
  return {
    rule: 'verify_admission',
    level: 'error' as const,
    blocking: true,
    message: `verify.sql${resolution.check === null ? '' : ` check ${resolution.check}`}: ${resolution.reason} (${resolution.construct.slice(0, 256)}).`,
    file: 'verify.sql' as const,
    statementIndex: resolution.check,
    line: null,
    remediation:
      'Use allowlisted built-ins on tables, or declare the consumer function or view (-- calls:, -- reads-view:) exactly.',
  }
}

export function migrationAnalysis(
  report: BundleReport,
  verify: VerifyAnalysis,
  sizes: ReadonlyMap<string, RelationSize>,
  searchPath: readonly string[],
  extraFindings: readonly LintEntry[] = [],
): MigrationAnalysis {
  const statements = report.statements
  const consumer = verify.resolution?.ok === true ? verify.resolution.consumer : []
  const consumerOf = (index: number): ConsumerCode | undefined =>
    consumer.find((c) => c.check === index)
  const rewriteRisk: {
    relation: string
    bytes: number | null
    rows: number | null
    estimate: true
  }[] = []
  for (const s of statements) {
    if (s.rewrite !== 'table' && s.rewrite !== 'possible') continue
    for (const l of s.locks) {
      const [schema, name] = l.on.includes('.') ? l.on.split('.', 2) : [null, l.on]
      const facts =
        schema !== null && schema !== undefined
          ? sizes.get(`${schema}.${name}`)
          : searchPath.map((p) => sizes.get(`${p}.${name}`)).find((f) => f !== undefined)
      rewriteRisk.push({
        relation: l.on.slice(0, 300),
        bytes: facts?.bytes ?? null,
        rows: facts?.rows ?? null,
        estimate: true,
      })
    }
  }
  // An invalid bundle has no declaration; it never reaches a plan (it is a blocking finding).
  const declared = report.compatibility.declared ?? 'destructive'
  const observed = report.compatibility.observed
  const order: readonly string[] = [...COMPATIBILITY_ORDER, 'unknown']
  return {
    migrationId: report.migrationId ?? '',
    statements: statements.map(statementAnalysis),
    compatibility: {
      declared,
      observed,
      agreement: observed !== 'unknown' && order.indexOf(declared) >= order.indexOf(observed),
    },
    destructive: statements
      .flatMap((s) =>
        s.objects
          .filter((o) => o.action === 'drop')
          .map((o) => `${o.kind} ${key(o.schema, o.name)}`),
      )
      .map((d) => d.slice(0, 300)),
    lockSeverity: report.lockSeverity,
    rewriteRisk,
    rollback: {
      available: report.rollbackStatements.length > 0,
      declaredSafety:
        (report.manifest?.rollback?.script === 'down.sql'
          ? report.manifest.rollback.safety
          : null) ?? null,
    },
    conditionalDdl: statements.some((s) => s.conditional),
    structuralExpectations: statements.reduce((n, s) => n + s.expectations.length, 0),
    underivedStatements: statements.filter((s) => s.coverage === 'underived').length,
    verify: {
      present: report.verify.present,
      checks: verify.checks.map((c) => {
        const code = consumerOf(c.index)
        return {
          index: c.index,
          name: c.name.slice(0, 128),
          class: code === undefined ? ('builtin' as const) : ('consumer_code' as const),
          covers: c.covers.map((v) => v.slice(0, 128)),
          consumer:
            code === undefined
              ? null
              : {
                  kind: code.kind,
                  identity: code.declared.slice(0, 400),
                  definitionDigest: code.digest,
                  securityDefiner: false,
                },
        }
      }),
    },
    lint: [...report.findings.map(lintEntry), ...extraFindings],
  }
}

export type { LockSeverity }
