import type { TargetSummary } from '@exponetdb/sdk/operations'
import { HEALTH_STATES, type HealthKey, isHealthKey } from '../fleet/health.tsx'

/**
 * The targets list as data: the grammar of a target path, the search
 * parameters of `/targets` (plain strings, every one validated against an
 * allowlist or a bound), and the filter and sort the page applies to the
 * targets it read. Pure functions, unit-tested with hostile input.
 */
const SLUG = /^[a-z][a-z0-9-]{0,38}$/

export interface TargetPathParts {
  readonly product: string
  readonly project: string
  readonly environment: string
}

/** The three segments of `product/project/environment`, or `undefined` for anything else. */
export function targetPathParts(path: string): TargetPathParts | undefined {
  const parts = path.split('/')
  const [product, project, environment] = parts
  if (
    parts.length !== 3 ||
    product === undefined ||
    project === undefined ||
    environment === undefined ||
    !SLUG.test(product) ||
    !SLUG.test(project) ||
    !SLUG.test(environment)
  ) {
    return undefined
  }
  return { product, project, environment }
}

/** The app path of a target page (or a section of it), only for a path of three valid slugs. */
export function targetHrefOf(path: string, suffix = ''): string | undefined {
  const parts = targetPathParts(path)
  if (parts === undefined) return undefined
  return `/t/${parts.product}/${parts.project}/${parts.environment}${suffix}`
}

export const TARGET_STATES = ['registered', 'active', 'suspended', 'decommissioned'] as const
export const STATE_FILTERS = ['all', ...TARGET_STATES] as const
export const SORTS = ['path', 'tier', 'health'] as const
export const VIEWS = ['table', 'grid'] as const
export const TIERS = ['prod', 'nonprod'] as const

export type StateFilter = (typeof STATE_FILTERS)[number]
export type Sort = (typeof SORTS)[number]
export type View = (typeof VIEWS)[number]
export type TierFilter = (typeof TIERS)[number]
export type HealthFilter = HealthKey | 'none'

export const SEARCH_MAX_LENGTH = 100

/** The validated search of `/targets`: a key that is absent or invalid is `undefined` (the default). */
export interface TargetsSearch {
  readonly q?: string | undefined
  readonly tier?: TierFilter | undefined
  /** Absent: every target that is not decommissioned. */
  readonly state?: StateFilter | undefined
  readonly health?: HealthFilter | undefined
  readonly sort?: Sort | undefined
  readonly view?: View | undefined
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' ? allowed.find((candidate) => candidate === value) : undefined
}

const CONTROL = /[\p{Cc}\p{Cf}]/u

/**
 * `validateSearch` of `/targets`. The router parses a numeric value such as
 * `?q=2024` as a number; it is read back as text. Text with a control or
 * format character (bidirectional overrides included), or longer than the
 * bound, is dropped, never shortened. All keys are always returned: the
 * router merges the validated search over the raw one, so a missing key would
 * let a raw value through.
 */
export function targetsSearch(search: Readonly<Record<string, unknown>>): TargetsSearch {
  const raw = search['q']
  const text = typeof raw === 'number' ? String(raw) : raw
  const q =
    typeof text === 'string' &&
    text.length > 0 &&
    text.length <= SEARCH_MAX_LENGTH &&
    !CONTROL.test(text)
      ? text
      : undefined
  return {
    q,
    tier: oneOf(TIERS, search['tier']),
    state: oneOf(STATE_FILTERS, search['state']),
    health: oneOf([...HEALTH_STATES, 'none'] as const, search['health']),
    sort: oneOf(SORTS, search['sort']),
    view: oneOf(VIEWS, search['view']),
  }
}

/** Whether any filter narrows the list (the sort and the view do not). */
export function isFiltered(search: TargetsSearch): boolean {
  return (
    search.q !== undefined ||
    search.tier !== undefined ||
    search.state !== undefined ||
    search.health !== undefined
  )
}

function healthOf(target: TargetSummary): HealthFilter {
  if (target.health === null) return 'none'
  return isHealthKey(target.health.state) ? target.health.state : 'unknown'
}

export function filterTargets(
  targets: readonly TargetSummary[],
  search: TargetsSearch,
): TargetSummary[] {
  const needle = search.q?.trim().toLowerCase()
  return targets.filter((target) => {
    const state = search.state
    if (state === undefined) {
      if (target.state === 'decommissioned') return false
    } else if (state !== 'all' && target.state !== state) {
      return false
    }
    if (search.tier !== undefined && target.tier !== search.tier) return false
    if (search.health !== undefined && healthOf(target) !== search.health) return false
    if (needle !== undefined && needle.length > 0 && !target.path.toLowerCase().includes(needle)) {
      return false
    }
    return true
  })
}

const HEALTH_RANK: Readonly<Record<string, number>> = {
  ...Object.fromEntries(HEALTH_STATES.map((state, index) => [state, index])),
  // A target with no sample sits with the unknown ones, never with the healthy.
  none: HEALTH_STATES.indexOf('unknown') + 0.5,
}

/** Sorts a copy: by path (default), production first, or worst health first; ties by path. */
export function sortTargets(
  targets: readonly TargetSummary[],
  sort: Sort | undefined,
): TargetSummary[] {
  const byPath = (a: TargetSummary, b: TargetSummary): number => a.path.localeCompare(b.path)
  const copy = [...targets]
  if (sort === 'tier') {
    return copy.sort(
      (a, b) => Number(b.tier === 'prod') - Number(a.tier === 'prod') || byPath(a, b),
    )
  }
  if (sort === 'health') {
    return copy.sort(
      (a, b) => (HEALTH_RANK[healthOf(a)] ?? 0) - (HEALTH_RANK[healthOf(b)] ?? 0) || byPath(a, b),
    )
  }
  return copy.sort(byPath)
}

/** The search with one change applied; a value equal to the default is removed from the URL. */
export function withSearch(search: TargetsSearch, change: Partial<TargetsSearch>): TargetsSearch {
  const next = { ...search, ...change }
  return {
    q: next.q === '' ? undefined : next.q,
    tier: next.tier,
    state: next.state,
    health: next.health,
    sort: next.sort === 'path' ? undefined : next.sort,
    view: next.view === 'table' ? undefined : next.view,
  }
}
