import type { StateKind } from './model.ts'

/**
 * `validateSearch` of `/t/…/connections`: each parameter is one of a fixed
 * list of values or absent, so nothing else ever reaches a request or the
 * page. The role, the application and the text search are not parameters:
 * they come from the data (equality) or are typed here, and stay in the
 * page. The keys are always returned (the router merges the validated search
 * over the raw one, so a missing key would let a raw value through).
 */
export const STATE_FILTERS = [
  'active',
  'waiting',
  'idle',
  'idle_in_transaction',
  'idle_in_transaction_aborted',
  'other',
] as const satisfies readonly StateKind[]
export const VIEWS = ['blockers'] as const
export const SORTS = ['longest'] as const
export const LAYOUTS = ['flat'] as const
/** The minimum ages the filter offers, in seconds (a way to narrow, not a threshold of ours). */
export const MIN_AGE_SECONDS = [10, 60, 300, 1_800] as const

export type MinAgeSeconds = (typeof MIN_AGE_SECONDS)[number]

export interface ConnectionsSearch {
  readonly state?: (typeof STATE_FILTERS)[number] | undefined
  readonly view?: (typeof VIEWS)[number] | undefined
  readonly sort?: (typeof SORTS)[number] | undefined
  readonly layout?: (typeof LAYOUTS)[number] | undefined
  readonly minAge?: MinAgeSeconds | undefined
}

function pick<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return values.find((candidate) => candidate === value)
}

/** The minimum age from a number or the text of one (the router parses `60` to a number). */
function pickMinAge(value: unknown): MinAgeSeconds | undefined {
  const number =
    typeof value === 'string' && /^(?:0|[1-9][0-9]{0,4})$/.test(value) ? Number(value) : value
  return MIN_AGE_SECONDS.find((candidate) => candidate === number)
}

export function connectionsSearch(search: Readonly<Record<string, unknown>>): ConnectionsSearch {
  return {
    state: pick(STATE_FILTERS, search['state']),
    view: pick(VIEWS, search['view']),
    sort: pick(SORTS, search['sort']),
    layout: pick(LAYOUTS, search['layout']),
    minAge: pickMinAge(search['minAge']),
  }
}

/** The query string of a change; only validated values, so nothing needs escaping. */
export function searchString(search: ConnectionsSearch): string {
  const parts: string[] = []
  if (search.state !== undefined) parts.push(`state=${search.state}`)
  if (search.view !== undefined) parts.push(`view=${search.view}`)
  if (search.sort !== undefined) parts.push(`sort=${search.sort}`)
  if (search.layout !== undefined) parts.push(`layout=${search.layout}`)
  if (search.minAge !== undefined) parts.push(`minAge=${search.minAge}`)
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

/** Whether a filter of the address narrows the list (sort and layout only arrange it). */
export function narrows(search: ConnectionsSearch): boolean {
  return search.state !== undefined || search.view !== undefined || search.minAge !== undefined
}
