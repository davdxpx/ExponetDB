import type { FindingFilters } from '../target-ops/keys.ts'

/**
 * `validateSearch` of `/t/…/findings`: each filter is one of the contract's
 * values or absent, so nothing else ever reaches the request. The keys are
 * always returned (the router merges the validated search over the raw one,
 * so a missing key would let a raw value through).
 */
export const SEVERITIES = ['info', 'warning', 'critical'] as const
export const STATES = ['open', 'resolved', 'all'] as const
export const KINDS = ['drift', 'health'] as const

export interface FindingsSearch {
  readonly severity?: (typeof SEVERITIES)[number]
  readonly state?: (typeof STATES)[number]
  readonly kind?: (typeof KINDS)[number]
}

function pick<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value)
}

export function findingsSearch(search: Readonly<Record<string, unknown>>): FindingsSearch {
  return {
    severity: pick(SEVERITIES, search['severity']),
    state: pick(STATES, search['state']),
    kind: pick(KINDS, search['kind']),
  }
}

/** The filters of a read: the state defaults to `open`, like the endpoint's. */
export function filtersOf(search: FindingsSearch): FindingFilters {
  return {
    state: search.state ?? 'open',
    ...(search.severity === undefined ? {} : { severity: search.severity }),
    ...(search.kind === undefined ? {} : { kind: search.kind }),
  }
}

/** The query string of a filter change; only validated values, so nothing needs escaping. */
export function searchString(search: FindingsSearch): string {
  const parts: string[] = []
  if (search.severity !== undefined) parts.push(`severity=${search.severity}`)
  if (search.state !== undefined && search.state !== 'open') parts.push(`state=${search.state}`)
  if (search.kind !== undefined) parts.push(`kind=${search.kind}`)
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}
