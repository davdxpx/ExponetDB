import type { ApprovalReview } from '@exponetdb/sdk/operations'
import { segmentLine, splitLines } from '@exponetdb/ui-patterns'

/**
 * The plan review as data (ADR-0029 §3 and §4; the Wave 7 rules of
 * `review.ts`, kept): what ExponetDB computed from the stored plan, and the
 * files the plan runs, verbatim, numbered, with the statement facts on the
 * file the plan executes and never on `verify.sql`. Every string from
 * outside ExponetDB (names, comments, SQL, the client's name) stays a raw
 * string here and is rendered through the untrusted-text components, which
 * show invisible and direction characters by code point. This module
 * decides nothing; it reshapes what the server computed.
 */
type Json = Record<string, unknown>
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

export interface StatementFact {
  readonly index: number
  readonly kind: string
  readonly line: number | undefined
  /**
   * The lock mode; `null` when the analysis derived no lock (`lock: null`),
   * `undefined` when the field is missing (not known, never "no lock").
   */
  readonly lock: string | null | undefined
  /** The lock's severity (`none` to `critical`, `unknown`); `undefined` when not given. */
  readonly lockSeverity: string | undefined
  readonly compatibility: string | undefined
  /** `none`, `table`, `possible`, `unknown`; `undefined` when not given. */
  readonly rewrite: string | undefined
  /** `false` for a statement that cannot run in a transaction; `undefined` when not given. */
  readonly transactional: boolean | undefined
  /** `derived`, `partly_derived`, `underived`; `undefined` when not given. */
  readonly coverage: string | undefined
  readonly destructive: boolean
}

export interface MigrationFacts {
  readonly migrationId: string
  /** Untrusted: the bundle's own name. */
  readonly name: string
  readonly compatibility: {
    readonly declared: string
    readonly observed: string
    readonly disagree: boolean
  }
  readonly lockSeverity: string
  readonly statements: readonly StatementFact[]
  /** Untrusted: object names the plan drops. */
  readonly drops: readonly string[]
  readonly rewrites: readonly {
    readonly relation: string
    readonly rows: number | undefined
    readonly bytes: number | undefined
  }[]
  readonly rollback:
    | { readonly available: true; readonly declaredSafety: string | undefined }
    | { readonly available: false }
  readonly checksum: string
}

export interface SourceLine {
  readonly number: number
  /** Untrusted: the line as stored. */
  readonly text: string
  /** The server's facts for a statement starting on this line (never on verify.sql). */
  readonly statement: StatementFact | undefined
}

export interface SourceView {
  readonly migrationId: string
  readonly file: string
  readonly revision: number
  readonly bytes: number
  readonly truncated: boolean
  readonly shownCharacters: number
  readonly lines: readonly SourceLine[]
  /** Characters outside printable ASCII (marked or shown by code point). */
  readonly marked: number
}

export interface Requirement {
  readonly kind: string
  readonly count: number | undefined
  readonly withinSeconds: number | undefined
}

export interface ReviewModel {
  readonly targetPath: string | null
  readonly tier: string | null
  readonly kind: string
  readonly class: string
  readonly actor: {
    readonly kind: string
    readonly identityId: string | null
    readonly via: string
  }
  /** Untrusted: the creating client's own name, never verified. */
  readonly clientName: string | null
  readonly decision: string
  readonly requirements: readonly Requirement[]
  readonly rules: readonly {
    readonly id: string
    readonly severity: string
    readonly result: string
    readonly message: string
  }[]
  /** Present for migration plans: the overall analysis and the bound state. */
  readonly migrationPlan:
    | {
        readonly compatibility: string
        readonly lockSeverity: string
        readonly destructive: boolean
        readonly nontransactional: boolean
        readonly evidence: string
        readonly schemaFingerprint: string
      }
    | undefined
  readonly expiresAt: string
  readonly planHash: string
  readonly migrations: readonly MigrationFacts[]
  readonly sources: readonly SourceView[]
  /** Files the plan runs that the server did not include (it sends at most 64). */
  readonly omitted: number
  readonly runs: number
}

/** The files the server shows per migration for each kind (application.ts, REVIEW_FILES). */
const FILES_PER_MIGRATION: Readonly<Record<string, number>> = {
  'migration.apply': 2,
  'migration.resume': 2,
  'migration.rollback': 1,
}

function statementFact(raw: unknown): StatementFact {
  const st = obj(raw)
  const lock = obj(st['lock'])
  return {
    index: num(st['index']) ?? 0,
    kind: str(st['kind']) ?? 'statement',
    line: num(st['line']),
    lock: st['lock'] === null ? null : str(lock['mode']),
    lockSeverity: str(lock['severity']),
    compatibility: str(st['compatibility']),
    rewrite: str(st['rewrite']),
    transactional: typeof st['transactional'] === 'boolean' ? st['transactional'] : undefined,
    coverage: str(st['coverage']),
    destructive: st['compatibility'] === 'destructive',
  }
}

function migrationFacts(item: Json, analysis: Json | undefined): MigrationFacts {
  const compatibility = obj(analysis?.['compatibility'])
  const rollback = obj(analysis?.['rollback'])
  return {
    migrationId: str(item['migrationId']) ?? '',
    name: str(item['name']) ?? '',
    compatibility: {
      declared: str(compatibility['declared']) ?? 'unknown',
      observed: str(compatibility['observed']) ?? 'unknown',
      disagree: compatibility['agreement'] === false,
    },
    lockSeverity: str(analysis?.['lockSeverity']) ?? 'unknown',
    statements: arr(analysis?.['statements']).map(statementFact),
    drops: arr(analysis?.['destructive']).filter((d): d is string => typeof d === 'string'),
    rewrites: arr(analysis?.['rewriteRisk']).map((r) => {
      const rewrite = obj(r)
      return {
        relation: str(rewrite['relation']) ?? '',
        rows: num(rewrite['rows']),
        bytes: num(rewrite['bytes']),
      }
    }),
    rollback:
      rollback['available'] === true
        ? { available: true, declaredSafety: str(rollback['declaredSafety']) }
        : { available: false },
    checksum: str(item['checksum']) ?? '',
  }
}

function sourceView(
  source: ApprovalReview['sources'][number],
  analysis: Json | undefined,
): SourceView {
  const starts = new Map<number, StatementFact>()
  for (const raw of arr(analysis?.['statements'])) {
    const fact = statementFact(raw)
    if (fact.line !== undefined) starts.set(fact.line, fact)
  }
  let marked = 0
  const lines = splitLines(source.text).map((text, i) => {
    marked += segmentLine(text).marked
    return { number: i + 1, text, statement: starts.get(i + 1) }
  })
  return {
    migrationId: source.migrationId,
    file: source.file,
    revision: source.revision,
    bytes: source.bytes,
    truncated: source.truncated,
    shownCharacters: source.text.length,
    lines,
    marked,
  }
}

export function reviewModel(review: ApprovalReview): ReviewModel {
  const plan = review.plan
  const content = obj(plan.change?.content)
  const analysis = obj(plan.change?.analysis)
  const perMigration = new Map<string, Json>()
  for (const a of arr(analysis['perMigration'])) {
    const id = str(obj(a)['migrationId'])
    if (id !== undefined) perMigration.set(id, obj(a))
  }
  const facts = obj(content['facts'])
  const summary = obj(analysis['summary'])
  const expected = obj(content['expectedState'])
  const migrations = arr(content['migrations']).map(obj)
  const perItem = FILES_PER_MIGRATION[plan.kind]
  const runs = plan.kind === 'migration.verify' ? 1 : migrations.length * (perItem ?? 0)
  return {
    targetPath: plan.subject.targetPath,
    tier: plan.subject.tier,
    kind: plan.kind,
    class: plan.class,
    actor: {
      kind: plan.actor.kind,
      identityId: plan.actor.identityId,
      via: plan.actor.via,
    },
    clientName: review.clientName,
    decision: plan.decision,
    requirements: plan.requirements.map((r) => {
      const record = r as unknown as Json
      return {
        kind: r.kind,
        count: num(record['count']),
        withinSeconds: num(record['withinSeconds']),
      }
    }),
    rules: (plan.policyRules ?? []).map((r) => ({
      id: r.id,
      severity: r.severity,
      result: r.result,
      message: r.message,
    })),
    migrationPlan:
      Object.keys(facts).length === 0
        ? undefined
        : {
            compatibility: str(summary['compatibility']) ?? 'unknown',
            lockSeverity: str(summary['lockSeverity']) ?? 'unknown',
            destructive: summary['destructive'] === true,
            nontransactional: summary['nontransactional'] === true,
            evidence: str(facts['evidence']) ?? 'unknown',
            schemaFingerprint: str(expected['schemaFingerprint']) ?? 'unknown',
          },
    expiresAt: plan.expiresAt,
    planHash: plan.planHash,
    migrations: migrations.map((m) =>
      migrationFacts(m, perMigration.get(str(m['migrationId']) ?? '')),
    ),
    // The statement facts belong to the file the plan executes, never to verify.sql.
    sources: review.sources.map((s) =>
      sourceView(s, s.file === 'verify.sql' ? undefined : perMigration.get(s.migrationId)),
    ),
    omitted: Math.max(0, runs - review.sources.length),
    runs,
  }
}
