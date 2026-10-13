import type {
  ApprovalQueueItem,
  ApprovalReview,
  OperationRead,
  PlanView,
} from '@exponetdb/sdk/operations'
import type {
  AnalysisOverallView,
  ApprovalEntry,
  BreakGlassView,
  EvidenceItemView,
  MigrationAnalysisView,
  PolicyRequirementView,
  PolicyRuleView,
  RawPlanFile,
  RollbackView,
  StatementAnalysisView,
  StatementLock,
} from '@exponetdb/ui-data'
import type { PlanClass, PlanConfirmFacts } from '@exponetdb/ui-patterns'
import { reviewModel } from './review-model.ts'

/**
 * The plan review page as data: the server's plan view (from `GET
 * /plans/{id}`, or the one the approvals queue sent with the review) turned
 * into the props of the ui-data plan blocks. Nothing is decided here: a value
 * the server did not give is `null` ("not known"), never the favorable case
 * (C-30); every foreign string (names, SQL, rule messages) stays raw for the
 * untrusted-text components. Pure functions, unit-tested with hostile input.
 */
type Json = Record<string, unknown>
const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {}
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const PLAN_ID = new RegExp(`^pln_${ULID}$`)
const OPERATION_ID = new RegExp(`^op_${ULID}$`)

/** Whether a value is a plan id (`pln_<ULID>`): the only thing a plan page path may carry. */
export function isPlanId(value: unknown): value is string {
  return typeof value === 'string' && PLAN_ID.test(value)
}

/** Whether a value is an operation id (`op_<ULID>`). */
export function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_ID.test(value)
}

/** The app path of a plan's review page, or `undefined` for anything that is not a plan id. */
export function planPath(planId: unknown): string | undefined {
  return isPlanId(planId) ? `/changes/plans/${planId}` : undefined
}

/** A plan view as the page reads it: the REST plan read carries the operation that applies it. */
export type PlanSource = PlanView & { readonly operationId?: string | null }

/** The lock of one analyzed statement: `none` only for an explicit `lock: null`. */
function lockOf(statement: Json): StatementLock {
  if (statement['lock'] === null) return 'none'
  const lock = obj(statement['lock'])
  const mode = str(lock['mode'])
  if (mode === null) return null
  return { mode, severity: str(lock['severity']) }
}

function statementOf(raw: unknown): StatementAnalysisView {
  const st = obj(raw)
  return {
    index: num(st['index']) ?? 0,
    line: num(st['line']),
    kind: str(st['kind']),
    lock: lockOf(st),
    compatibility: str(st['compatibility']),
    // A field the server did not send stays "not known" (undefined), never "none".
    rewrite: typeof st['rewrite'] === 'string' ? st['rewrite'] : undefined,
    transactional: bool(st['transactional']),
    coverage: str(st['coverage']),
  }
}

function rollbackOf(raw: unknown): RollbackView | null {
  const rollback = obj(raw)
  if (rollback['available'] === true) {
    return { available: true, declaredSafety: str(rollback['declaredSafety']) }
  }
  return rollback['available'] === false ? { available: false } : null
}

/** One migration of the plan with its analysis; without an analysis every fact is "not known". */
export function migrationAnalysisOf(item: Json, analysis: Json | undefined): MigrationAnalysisView {
  const migrationId = str(item['migrationId']) ?? ''
  const checksum = str(item['checksum'])
  const name = str(item['name'])
  if (analysis === undefined) {
    return {
      migrationId,
      name,
      compatibility: null,
      lockSeverity: null,
      statements: null,
      drops: null,
      rewrites: null,
      rollback: null,
      checksum,
    }
  }
  const compatibility = analysis['compatibility']
  const statements = arr(analysis['statements'])
  const drops = arr(analysis['destructive'])
  const rewrites = arr(analysis['rewriteRisk'])
  return {
    migrationId,
    name,
    compatibility:
      compatibility === undefined || compatibility === null
        ? null
        : {
            declared: str(obj(compatibility)['declared']),
            observed: str(obj(compatibility)['observed']),
            disagree:
              typeof obj(compatibility)['agreement'] === 'boolean'
                ? obj(compatibility)['agreement'] === false
                : null,
          },
    lockSeverity: str(analysis['lockSeverity']),
    statements: statements === null ? null : statements.map(statementOf),
    drops: drops === null ? null : drops.filter((d): d is string => typeof d === 'string'),
    rewrites:
      rewrites === null
        ? null
        : rewrites.map((r) => {
            const rewrite = obj(r)
            return {
              relation: str(rewrite['relation']) ?? '',
              rows: num(rewrite['rows']),
              bytes: num(rewrite['bytes']),
            }
          }),
    rollback: rollbackOf(analysis['rollback']),
    checksum,
  }
}

/** The analysis of a migration plan, per migration in plan order, and the overall summary. */
export interface PlanAnalysis {
  readonly overall: AnalysisOverallView | null
  readonly migrations: readonly MigrationAnalysisView[] | null
  /** Statement classes found by the analysis; `null` when not all facts are known. */
  readonly classifications: readonly string[] | null
}

export function analysisOf(plan: PlanView): PlanAnalysis | undefined {
  if (!plan.kind.startsWith('migration.') || plan.change === undefined) return undefined
  const content = obj(plan.change.content)
  const analysis = obj(plan.change.analysis)
  const perMigration = new Map<string, Json>()
  for (const a of arr(analysis['perMigration']) ?? []) {
    const id = str(obj(a)['migrationId'])
    if (id !== null) perMigration.set(id, obj(a))
  }
  const items = arr(content['migrations'])
  const migrations =
    items === null
      ? null
      : items.map((m) =>
          migrationAnalysisOf(obj(m), perMigration.get(str(obj(m)['migrationId']) ?? '')),
        )
  const summaryRaw = analysis['summary']
  const summary = obj(summaryRaw)
  const overall: AnalysisOverallView | null =
    summaryRaw === undefined || summaryRaw === null
      ? null
      : {
          compatibility: str(summary['compatibility']),
          lockSeverity: str(summary['lockSeverity']),
          destructive: bool(summary['destructive']),
          nontransactional: bool(summary['nontransactional']),
        }
  return { overall, migrations, classifications: classificationsOf(overall, migrations) }
}

/**
 * The statement classes of the whole plan from the server's facts: a drop
 * (`destructive`), a table rewrite and a part outside one transaction. When a
 * fact behind a class is not known the answer is `null`, never "none found".
 */
export function classificationsOf(
  overall: AnalysisOverallView | null,
  migrations: readonly MigrationAnalysisView[] | null,
): readonly string[] | null {
  if (overall === null || migrations === null) return null
  if (overall.destructive === null || overall.nontransactional === null) return null
  const classes: string[] = []
  if (overall.destructive) classes.push('destructive')
  let rewriteKnown = true
  let rewrite = false
  for (const migration of migrations) {
    if (migration.rewrites === null || migration.statements === null) {
      rewriteKnown = false
      continue
    }
    if (migration.rewrites.length > 0) rewrite = true
    for (const statement of migration.statements) {
      if (statement.rewrite === 'table' || statement.rewrite === 'possible') rewrite = true
      else if (statement.rewrite !== 'none') rewriteKnown = false
    }
  }
  if (rewrite) classes.push('rewrite')
  if (overall.nontransactional) classes.push('non_transactional')
  if (!rewrite && !rewriteKnown) return null
  return classes
}

/** The evidence facts of a migration plan. */
export interface PlanEvidence {
  readonly evidence: string | null
  readonly items: readonly EvidenceItemView[] | null
  readonly breakGlass: BreakGlassView | null
  readonly schemaFingerprint: string | null
}

export function evidenceOf(plan: PlanView): PlanEvidence | undefined {
  if (!plan.kind.startsWith('migration.') || plan.change === undefined) return undefined
  const content = obj(plan.change.content)
  const analysis = obj(plan.change.analysis)
  const items = arr(analysis['evidence'])
  const breakGlass = content['breakGlass']
  return {
    evidence: str(obj(content['facts'])['evidence']),
    items:
      items === null
        ? null
        : items.map((raw) => {
            const item = obj(raw)
            return {
              migrationId: str(item['migrationId']) ?? '',
              status: str(item['status']),
              verifiedAt: str(item['verifiedAt']),
            }
          }),
    breakGlass:
      breakGlass === undefined || breakGlass === null
        ? null
        : {
            grantId: str(obj(breakGlass)['grantId']) ?? '',
            rules: (arr(obj(breakGlass)['rules']) ?? []).filter(
              (r): r is string => typeof r === 'string',
            ),
          },
    schemaFingerprint: str(obj(content['expectedState'])['schemaFingerprint']),
  }
}

export function requirementsOf(plan: PlanView): readonly PolicyRequirementView[] {
  return plan.requirements.map((requirement) => {
    const r = requirement as unknown as Json
    return {
      kind: requirement.kind,
      count: num(r['count']),
      permission: str(r['permission']),
      withinSeconds: num(r['withinSeconds']),
      newerThan: str(r['newerThan']),
      windowId: str(r['windowId']),
      rules: arr(r['rules'])?.filter((x): x is string => typeof x === 'string') ?? null,
    }
  })
}

export function rulesOf(plan: PlanView): readonly PolicyRuleView[] | null {
  if (plan.policyRules === undefined) return null
  return plan.policyRules.map((rule) => ({
    id: rule.id,
    severity: rule.severity,
    result: rule.result,
    message: rule.message,
    remediation: rule.remediation ?? null,
    overridableByBreakGlass: rule.overridableByBreakGlass,
  }))
}

/** The decisions so far on an operation of the queue, oldest first. */
export function approvalEntriesOf(item: ApprovalQueueItem): readonly ApprovalEntry[] {
  return item.approvals.map((approval) => ({
    id: approval.id,
    approverIdentityId: approval.approverIdentityId,
    decision: approval.decision,
    selfApproval: approval.selfApproval,
    decidedAt: approval.decidedAt,
    notBefore: approval.notBefore,
  }))
}

/** The files the plan runs as the raw text block shows them (from the approval review only). */
export interface PlanFiles {
  readonly files: readonly RawPlanFile[]
  readonly omitted: number
  readonly runs: number
}

export function filesOf(review: ApprovalReview): PlanFiles {
  const model = reviewModel(review)
  return {
    files: model.sources.map((source, i) => ({
      migrationId: source.migrationId,
      file: source.file,
      revision: source.revision,
      bytes: source.bytes,
      truncated: source.truncated,
      // The copy button copies the text exactly as the server sent it.
      text: review.sources[i]?.text,
      lines: source.lines.map((line) => ({
        text: line.text,
        statement:
          line.statement === undefined
            ? undefined
            : {
                index: line.statement.index,
                kind: line.statement.kind,
                lock: line.statement.lock,
                compatibility: line.statement.compatibility ?? null,
                destructive: line.statement.destructive,
              },
      })),
    })),
    omitted: model.omitted,
    runs: model.runs,
  }
}

/** The plan classes the confirmation ladder knows; anything else needs the typed path (fails closed). */
function confirmClassOf(value: string): PlanClass {
  return value === 'low' || value === 'standard' || value === 'critical' ? value : 'high'
}

/** What a person types to confirm a plan of class `high` or `critical`: the target path, else the subject id. */
export function subjectTextOf(plan: PlanView): string {
  return plan.subject.targetPath ?? plan.subject.clusterId ?? plan.subject.nodeId ?? plan.id
}

/**
 * The facts the plan confirmation shows and returns: the plan hash exactly as
 * the page shows it, the tier (a missing one is production, failing closed),
 * the class and the subject to type. The effect a `critical` plan needs typed
 * as well is the plan's kind and its subject, in the server's own words.
 */
export function confirmFactsOf(plan: PlanView): PlanConfirmFacts {
  const planClass = confirmClassOf(plan.class)
  const subject = subjectTextOf(plan)
  return {
    planHash: plan.planHash,
    tier: plan.subject.tier === 'nonprod' ? 'nonprod' : 'prod',
    planClass,
    targetPath: subject,
    ...(planClass === 'critical' ? { effect: `${plan.kind} ${subject}` } : {}),
  }
}

/** Operation states in which the operation is still at work: the page reads it more often. */
export function operationActive(operation: OperationRead | undefined): boolean {
  return (
    operation !== undefined &&
    (operation.state === 'queued' ||
      operation.state === 'running' ||
      operation.state === 'verifying')
  )
}
