import type { PlanState } from '@exponetdb/sdk/operations'
import { isKindFilter } from '../changes/model.ts'
import { isTargetPath } from '../target/params.ts'
import { isTargetId } from '../target-ops/ids.ts'

/**
 * The search of the plan list (`/changes/plans`) as data, following the
 * operations list: plain strings in the address, each checked against an
 * allowlist or a grammar, never free text sent on. `awaiting=approval` is
 * not a plan state (a plan whose apply was accepted is `consumed`; its
 * operation waits): that view reads the operations that wait for an
 * approval and lists their plans. Pure functions, unit-tested with hostile
 * input.
 */

/** The plan states of the contract (`PlanState`), in the order the filter offers them. */
export const PLAN_STATES = [
  'active',
  'consumed',
  'expired',
  'invalidated',
  'denied',
  'withdrawn',
] as const satisfies readonly PlanState[]

/** The longest kind `GET /plans` takes (`kind`, `maxLength`). */
export const PLAN_KIND_MAX_LENGTH = 64

export const PLANS_PATH = '/changes/plans'

export interface PlanListSearch {
  readonly state?: PlanState | undefined
  readonly kind?: string | undefined
  /** Absent: every plan the person may read (`any`). */
  readonly actor?: 'self' | undefined
  /** A target path or `tgt_` id. */
  readonly target?: string | undefined
  /** `approval`: the plans whose operation waits for an approval. */
  readonly awaiting?: 'approval' | undefined
}

/** Whether a value is a plan kind the filter may send: the operation-kind grammar, at most 64. */
export function isPlanKind(value: unknown): value is string {
  return isKindFilter(value) && value.length <= PLAN_KIND_MAX_LENGTH
}

/** Whether a value names a target the filter may send: a target path or a `tgt_` id. */
export function isTargetFilter(value: unknown): value is string {
  return isTargetPath(value) || isTargetId(value)
}

/**
 * `validateSearch` of `/changes/plans`. Every key is always returned (the
 * router merges the validated search over the raw one, so a missing key
 * would let a raw value through); anything outside the allowlists and
 * grammars is dropped, never shortened. A plan state does not combine with
 * `awaiting=approval` (those plans are consumed by definition): the state
 * is dropped.
 */
export function planListSearch(search: Readonly<Record<string, unknown>>): PlanListSearch {
  const state = search['state']
  const kind = search['kind']
  const target = search['target']
  const awaiting = search['awaiting'] === 'approval' ? 'approval' : undefined
  return {
    state:
      awaiting === undefined && typeof state === 'string'
        ? PLAN_STATES.find((candidate) => candidate === state)
        : undefined,
    kind: isPlanKind(kind) ? kind : undefined,
    actor: search['actor'] === 'self' ? 'self' : undefined,
    target: isTargetFilter(target) ? target : undefined,
    awaiting,
  }
}

/** The query of `GET /plans` for a validated search (`actor=any` is the default and is sent). */
export function planListQueryOf(search: PlanListSearch): {
  readonly state?: PlanState
  readonly kind?: string
  readonly target?: string
  readonly actor: 'self' | 'any'
} {
  return {
    ...(search.state === undefined ? {} : { state: search.state }),
    ...(search.kind === undefined ? {} : { kind: search.kind }),
    ...(search.target === undefined ? {} : { target: search.target }),
    actor: search.actor ?? 'any',
  }
}

/** The query of `GET /operations` behind "Awaiting approval": the same filters, operations that wait. */
export function awaitingQueryOf(search: PlanListSearch): {
  readonly state: 'awaiting_approval'
  readonly kind?: string
  readonly target?: string
  readonly actor: 'self' | 'any'
} {
  return {
    state: 'awaiting_approval',
    ...(search.kind === undefined ? {} : { kind: search.kind }),
    ...(search.target === undefined ? {} : { target: search.target }),
    actor: search.actor ?? 'any',
  }
}

export function isPlanListFiltered(search: PlanListSearch): boolean {
  return (
    search.state !== undefined ||
    search.kind !== undefined ||
    search.actor !== undefined ||
    search.target !== undefined ||
    search.awaiting !== undefined
  )
}

/** The address of the plan list with a validated search (only the keys that are set). */
export function planListHref(search: PlanListSearch): string {
  const params = new URLSearchParams()
  const checked = planListSearch(search as Readonly<Record<string, unknown>>)
  for (const key of ['state', 'kind', 'actor', 'target', 'awaiting'] as const) {
    const value = checked[key]
    if (value !== undefined) params.set(key, value)
  }
  const query = params.toString()
  return query.length === 0 ? PLANS_PATH : `${PLANS_PATH}?${query}`
}
