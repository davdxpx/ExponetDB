import type {
  MigrationStream,
  OperationRead,
  OperationState,
  PlanView,
} from '@exponetdb/sdk/operations'
import {
  type MigrationTimelineData,
  markerStateFromStream,
  type TimelineCell,
} from '@exponetdb/ui-data'
import type { PlanConfirmFacts } from '@exponetdb/ui-patterns'
import type { MessageKey } from '../../lib/i18n/i18n.ts'
import { isOperationId } from '../plans/plan-model.ts'

/**
 * The Changes screens as data: the search parameters of the operations list
 * and the promotion view (plain strings, each checked against an allowlist
 * or a grammar), the paths of an operation page, the polling interval of an
 * operation, the confirmation of "Verify again", the catalog text of an
 * operation's error code and the promotion stream as timeline data. Nothing
 * is decided here: a value the server did not give stays "not known". Pure
 * functions, unit-tested with hostile input.
 */
const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const PROJECT_ID = new RegExp(`^prj_${ULID}$`)

export const OPERATIONS_PATH = '/changes/operations'
export const PROMOTION_PATH = '/changes/promotion'

/** The operation states of the contract, in the order the list's filter offers them. */
export const OPERATION_STATES = [
  'awaiting_approval',
  'queued',
  'running',
  'verifying',
  'needs_attention',
  'needs_reconciliation',
  'succeeded',
  'failed',
  'verification_failed',
  'canceled',
] as const satisfies readonly OperationState[]

/** States from which an operation never moves again: its page stops asking. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'verification_failed',
  'canceled',
])

/** States in which the server accepts a cancel (`POST /operations/{id}/cancel`). */
export const CANCELABLE_STATES: ReadonlySet<string> = new Set(['awaiting_approval', 'queued'])

export const ACTORS = ['any', 'self'] as const
export type ActorFilter = (typeof ACTORS)[number]

/** An operation kind as the filter accepts it: lower-case words joined by dots or underscores. */
const KIND = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,5}$/
export const KIND_MAX_LENGTH = 80

/** The validated search of `/changes/operations`: an absent or invalid key is `undefined`. */
export interface OperationsSearch {
  readonly state?: OperationState | undefined
  readonly kind?: string | undefined
  /** Absent: every operation the person may read (`any`). */
  readonly actor?: 'self' | undefined
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' ? allowed.find((candidate) => candidate === value) : undefined
}

/** Whether a value is an operation kind the filter may send (never free text). */
export function isKindFilter(value: unknown): value is string {
  return typeof value === 'string' && value.length <= KIND_MAX_LENGTH && KIND.test(value)
}

/**
 * `validateSearch` of `/changes/operations`. Every key is always returned
 * (the router merges the validated search over the raw one, so a missing key
 * would let a raw value through); anything outside the allowlist or the kind
 * grammar is dropped, never shortened.
 */
export function operationsSearch(search: Readonly<Record<string, unknown>>): OperationsSearch {
  const kind = search['kind']
  return {
    state: oneOf(OPERATION_STATES, search['state']),
    kind: isKindFilter(kind) ? kind : undefined,
    actor: search['actor'] === 'self' ? 'self' : undefined,
  }
}

/** The query of `GET /operations` for a validated search (`actor=any` is the default and is sent). */
export function operationsQueryOf(search: OperationsSearch): {
  readonly state?: OperationState
  readonly kind?: string
  readonly actor: ActorFilter
} {
  return {
    ...(search.state === undefined ? {} : { state: search.state }),
    ...(search.kind === undefined ? {} : { kind: search.kind }),
    actor: search.actor ?? 'any',
  }
}

export function isFiltered(search: OperationsSearch): boolean {
  return search.state !== undefined || search.kind !== undefined || search.actor !== undefined
}

/** The app path of an operation page, or `undefined` for anything that is not an operation id. */
export function operationPath(operationId: unknown): string | undefined {
  return isOperationId(operationId) ? `${OPERATIONS_PATH}/${operationId}` : undefined
}

/** The operations list filtered to one state (the fleet overview's links). */
export function operationsInState(state: OperationState): string {
  return `${OPERATIONS_PATH}?state=${state}`
}

/** Whether a value is a project id (`prj_<ULID>`). */
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID.test(value)
}

export interface PromotionSearch {
  readonly project?: string | undefined
}

/** `validateSearch` of `/changes/promotion`: only a project id passes. */
export function promotionSearch(search: Readonly<Record<string, unknown>>): PromotionSearch {
  const project = search['project']
  return { project: isProjectId(project) ? project : undefined }
}

export function promotionPath(projectId: string): string | undefined {
  return isProjectId(projectId) ? `${PROMOTION_PATH}?project=${projectId}` : undefined
}

/** How often an operation page asks again, and the bounds of its backoff. */
export const operationPolling = {
  /** An operation at work that changed in the last minute. */
  activeMs: 3_000,
  /** An operation at work that has not changed for a while. */
  slowMs: 10_000,
  /** An operation that waits for a person (approval, attention, reconciliation). */
  waitingMs: 30_000,
  /** The longest wait after failed reads. */
  maxMs: 60_000,
}

const ACTIVE: ReadonlySet<string> = new Set(['queued', 'running', 'verifying'])

/**
 * The next poll of an operation page, or `false` to stop: a terminal
 * operation is not asked again, and neither is one the server does not
 * show. An operation at work is asked often while it changes and less often
 * once it has been quiet for a minute; one that waits for a person is asked
 * rarely. Failed reads double the wait up to `maxMs`. While the tab is
 * hidden the query cache does not poll at all (`refetchIntervalInBackground:
 * false`); this function never decides that on its own.
 */
export function operationPollInterval(
  operation: Pick<OperationRead, 'state' | 'updatedAt'> | undefined,
  failures: number,
  now: number,
): number | false {
  if (operation !== undefined && TERMINAL_STATES.has(operation.state)) return false
  let base = operationPolling.waitingMs
  if (operation === undefined) {
    base = operationPolling.activeMs
  } else if (ACTIVE.has(operation.state)) {
    const changed = Date.parse(operation.updatedAt)
    const quiet = Number.isFinite(changed) && now - changed > 60_000
    base = quiet ? operationPolling.slowMs : operationPolling.activeMs
  }
  const backoff = base * 2 ** Math.min(Math.max(failures, 0), 6)
  return Math.min(backoff, Math.max(base, operationPolling.maxMs))
}

/** Which rung of the confirmation ladder "Verify again" uses. */
export type VerifyAgainRung =
  | { readonly kind: 'plan'; readonly facts: PlanConfirmFacts }
  | { readonly kind: 'typed'; readonly targetPath: string }
  | { readonly kind: 'confirm' }

/**
 * "Verify again" on a non-production subject is a plain confirmation. On a
 * production subject (or one whose tier is not known, failing closed) it is
 * the plan confirmation with the facts of the plan that made the change,
 * so the person sees the target, the class and the plan hash and types the
 * target path where the class asks for it. When that plan cannot be read the
 * person types the target path (or the subject id) instead.
 */
export function verifyAgainRung(
  operation: Pick<OperationRead, 'subject' | 'id'>,
  facts: PlanConfirmFacts | undefined,
): VerifyAgainRung {
  if (operation.subject.tier === 'nonprod') return { kind: 'confirm' }
  if (facts !== undefined) return { kind: 'plan', facts }
  return {
    kind: 'typed',
    targetPath:
      operation.subject.targetPath ??
      operation.subject.clusterId ??
      operation.subject.nodeId ??
      operation.id,
  }
}

/** The plan view the confirmation needs, from `GET /plans/{id}`. */
export type PlanFacts = Pick<PlanView, 'planHash' | 'class' | 'subject' | 'kind' | 'id'>

/**
 * The catalog text of the error codes an operation carries
 * (`packages/contracts/generated/catalog.json`, `errors.<code>.message`),
 * as message keys. A test keeps every text equal to the catalog. A code not
 * listed here is shown with its code and "not known to this version".
 */
export const OPERATION_ERROR_TEXT: Readonly<Record<string, MessageKey>> = {
  PLAN_STALE: 'changes.code.PLAN_STALE',
  PLAN_EXPIRED: 'changes.code.PLAN_EXPIRED',
  PLAN_ALREADY_USED: 'changes.code.PLAN_ALREADY_USED',
  PLAN_BINDING_ACTOR: 'changes.code.PLAN_BINDING_ACTOR',
  PLAN_DENIED: 'changes.code.PLAN_DENIED',
  APPROVAL_REQUIRED: 'changes.code.APPROVAL_REQUIRED',
  HUMAN_APPLY_REQUIRED: 'changes.code.HUMAN_APPLY_REQUIRED',
  APPROVAL_COOLING_PERIOD: 'changes.code.APPROVAL_COOLING_PERIOD',
  OPERATION_CONFLICT: 'changes.code.OPERATION_CONFLICT',
  OPERATION_NOT_CANCELABLE: 'changes.code.OPERATION_NOT_CANCELABLE',
  OPERATION_NOT_RETRYABLE: 'changes.code.OPERATION_NOT_RETRYABLE',
  OPERATION_CANCELLED: 'changes.code.OPERATION_CANCELLED',
  OUTCOME_UNKNOWN: 'changes.code.OUTCOME_UNKNOWN',
  MIGRATION_CHECKSUM_MISMATCH: 'changes.code.MIGRATION_CHECKSUM_MISMATCH',
  MIGRATION_DEPENDENCY_MISSING: 'changes.code.MIGRATION_DEPENDENCY_MISSING',
  MIGRATION_DEPENDENCY_UNVERIFIED: 'changes.code.MIGRATION_DEPENDENCY_UNVERIFIED',
  MIGRATION_ALREADY_APPLIED: 'changes.code.MIGRATION_ALREADY_APPLIED',
  MIGRATION_STATEMENT_FORBIDDEN: 'changes.code.MIGRATION_STATEMENT_FORBIDDEN',
  MIGRATION_LOCK_TIMEOUT: 'changes.code.MIGRATION_LOCK_TIMEOUT',
  MIGRATION_EXECUTION_FAILED: 'changes.code.MIGRATION_EXECUTION_FAILED',
  MIGRATION_REQUIREMENT_UNMET: 'changes.code.MIGRATION_REQUIREMENT_UNMET',
  MIGRATION_INCOMPLETE: 'changes.code.MIGRATION_INCOMPLETE',
  MIGRATION_REVERTED: 'changes.code.MIGRATION_REVERTED',
  VERIFICATION_FAILED: 'changes.code.VERIFICATION_FAILED',
  VERIFICATION_ERROR: 'changes.code.VERIFICATION_ERROR',
  SCHEMA_FINGERPRINT_MISMATCH: 'changes.code.SCHEMA_FINGERPRINT_MISMATCH',
  LEDGER_DIVERGENCE: 'changes.code.LEDGER_DIVERGENCE',
  LEDGER_NOT_INITIALIZED: 'changes.code.LEDGER_NOT_INITIALIZED',
  STAGING_EVIDENCE_MISSING: 'changes.code.STAGING_EVIDENCE_MISSING',
  STAGING_VERIFICATION_FAILED: 'changes.code.STAGING_VERIFICATION_FAILED',
  STAGING_EVIDENCE_UNREACHABLE: 'changes.code.STAGING_EVIDENCE_UNREACHABLE',
  POLICY_DENIED: 'changes.code.POLICY_DENIED',
  MAINTENANCE_WINDOW_REQUIRED: 'changes.code.MAINTENANCE_WINDOW_REQUIRED',
}

export function errorTextKey(code: string): MessageKey | undefined {
  return Object.hasOwn(OPERATION_ERROR_TEXT, code) ? OPERATION_ERROR_TEXT[code] : undefined
}

/** The labels of operation states (`OperationState`); an unknown one is shown as its own text. */
export const STATE_TEXT: Readonly<Record<string, MessageKey>> = {
  awaiting_approval: 'changes.state.awaiting_approval',
  queued: 'changes.state.queued',
  running: 'changes.state.running',
  verifying: 'changes.state.verifying',
  needs_attention: 'changes.state.needs_attention',
  needs_reconciliation: 'changes.state.needs_reconciliation',
  succeeded: 'changes.state.succeeded',
  failed: 'changes.state.failed',
  verification_failed: 'changes.state.verification_failed',
  canceled: 'changes.state.canceled',
}

export function stateTextKey(state: string): MessageKey | undefined {
  return Object.hasOwn(STATE_TEXT, state) ? STATE_TEXT[state] : undefined
}

/** Apply outcomes of the list (`ApplyOutcome`): words only; "applied" is never a success. */
export const APPLY_TEXT: Readonly<Record<string, MessageKey>> = {
  not_started: 'changes.apply.not_started',
  applied: 'changes.apply.applied',
  not_applied: 'changes.apply.not_applied',
  partially_applied: 'changes.apply.partially_applied',
  unknown: 'changes.apply.unknown',
}

/** Verification outcomes of the list (`VerificationOutcome`). */
export const VERIFICATION_TEXT: Readonly<Record<string, MessageKey>> = {
  not_applicable: 'changes.verification.not_applicable',
  pending: 'changes.verification.pending',
  passed: 'changes.verification.passed',
  failed: 'changes.verification.failed',
  partial: 'changes.verification.partial',
  error: 'changes.verification.error',
}

export function outcomeKey(
  table: Readonly<Record<string, MessageKey>>,
  value: string,
): MessageKey | undefined {
  return Object.hasOwn(table, value) ? table[value] : undefined
}

/**
 * The promotion stream (`GET /projects/{id}/migrations`) as timeline data:
 * environments in the server's evidence order, one row per bundle with the
 * mirror's state per environment. A cell the stream does not hold stays
 * absent, which the timeline shows as `unknown`, never "not applied".
 */
export function timelineOf(stream: MigrationStream): MigrationTimelineData {
  const environments = [...stream.environments]
    .sort((a, b) => a.rank - b.rank)
    .map((environment) => ({
      id: environment.slug,
      name: environment.displayName,
      tier: environment.tier,
      evidenceFrom: environment.evidenceFrom,
    }))
  const bundles = stream.bundles.map((bundle) => ({
    id: bundle.migrationId,
    slug: bundle.name,
    dependsOn: bundle.dependsOn,
    cells: bundle.states.map(
      (cell): TimelineCell => ({
        environmentId: cell.environment,
        state: markerStateFromStream(cell.state),
        at: cell.verification?.verifiedAt ?? cell.appliedAt,
        observedAt: cell.observedAt,
      }),
    ),
  }))
  return {
    environments,
    bundles,
    baselines: stream.baselines,
    ...(stream.truncated ? { totalBundleCount: stream.bundleCount } : {}),
  }
}
