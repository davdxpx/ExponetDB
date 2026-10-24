import { isTargetPath } from '../target/params.ts'

/**
 * `validateSearch` of `/findings`: each filter is one of the contract's values
 * (`GET /findings`: severity, state, kind) or, for `target`, a target path that
 * matches the slug grammar exactly, or absent, so nothing else ever reaches the
 * request or a link. The keys are always returned (the router merges the
 * validated search over the raw one, so a missing key would let a raw value
 * through).
 */
export const SEVERITIES = ['info', 'warning', 'critical'] as const
export const STATES = ['open', 'resolved', 'all'] as const
export const KINDS = ['drift', 'health'] as const

export interface GlobalFindingsSearch {
  readonly severity?: (typeof SEVERITIES)[number]
  readonly state?: (typeof STATES)[number]
  readonly kind?: (typeof KINDS)[number]
  /** `<product>/<project>/<environment>` of the one target to look at. */
  readonly target?: string
}

/** What a read asks for: the state defaults to `open`, like the endpoint's. */
export interface GlobalFindingFilters {
  readonly state: (typeof STATES)[number]
  readonly severity?: (typeof SEVERITIES)[number]
  readonly kind?: (typeof KINDS)[number]
  readonly target?: string
}

function pick<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value)
}

export function globalFindingsSearch(
  search: Readonly<Record<string, unknown>>,
): GlobalFindingsSearch {
  const target = search['target']
  return {
    severity: pick(SEVERITIES, search['severity']),
    state: pick(STATES, search['state']),
    kind: pick(KINDS, search['kind']),
    target: isTargetPath(target) ? target : undefined,
  }
}

export function filtersOf(search: GlobalFindingsSearch): GlobalFindingFilters {
  return {
    state: search.state ?? 'open',
    ...(search.severity === undefined ? {} : { severity: search.severity }),
    ...(search.kind === undefined ? {} : { kind: search.kind }),
    ...(search.target === undefined ? {} : { target: search.target }),
  }
}

/**
 * The query string of a filter change. Every value passed the grammar above, and
 * the target path is made of slugs and slashes, so nothing needs escaping beyond
 * the slash, which a query string may carry.
 */
export function searchString(search: GlobalFindingsSearch): string {
  const parts: string[] = []
  if (search.severity !== undefined) parts.push(`severity=${search.severity}`)
  if (search.state !== undefined && search.state !== 'open') parts.push(`state=${search.state}`)
  if (search.kind !== undefined) parts.push(`kind=${search.kind}`)
  if (search.target !== undefined && isTargetPath(search.target)) {
    parts.push(`target=${search.target}`)
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}
