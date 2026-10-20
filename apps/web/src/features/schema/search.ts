import { defaultStringifySearch } from '@tanstack/react-router'
import { targetHref } from '../../shell/navigation.ts'
import type { SchemaKind } from '../target/params.ts'
import type { ObjectKey } from './schema-model.ts'

/**
 * The validated search of `/t/…/schema/<kind>`: what a link carries so that a
 * selected object, the name filter, the schema, the tab and the row browser's
 * sort and filters survive a reload and can be shared. Everything in a link is
 * input (C-26): a key that is absent or invalid is `undefined` (the default),
 * never shortened or repaired, and no value of a link ever reaches SQL except
 * as a bind parameter after the row browser has matched it against the columns
 * of the object. Reading a link never runs a data read: the row browser opens
 * idle and waits for the person's press.
 *
 * Like `targetsSearch`, the validator always returns every key, because the
 * router merges the validated search over the raw one and a missing key would
 * let a raw value through.
 */

/** The most filters a link or the row browser holds. */
export const MAX_FILTERS = 5
/** The longest filter value, in UTF-16 units. */
export const FILTER_VALUE_MAX = 1_000
/** The longest text of a column name, a schema name or one part of an object's key. */
export const NAME_MAX = 2_048
/** The most parts of an object's canonical key (the contract's `maxItems`). */
export const OBJECT_KEY_MAX_PARTS = 8
/** The longest name filter (the contract's `q` is 1 to 128 characters). */
export const SEARCH_Q_MAX = 128

/** The operators of a filter row: a fixed allowlist, never text from a link. */
export const FILTER_OPS = [
  '=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  'IS NULL',
  'IS NOT NULL',
  'ILIKE',
] as const
export type FilterOp = (typeof FILTER_OPS)[number]

export function isFilterOp(value: unknown): value is FilterOp {
  return typeof value === 'string' && FILTER_OPS.some((op) => op === value)
}

/** The operators that take no value. */
export function isNullOp(op: FilterOp): boolean {
  return op === 'IS NULL' || op === 'IS NOT NULL'
}

/** One filter in a link: column, operator, value (`''` for the operators without one). */
export type UrlFilter = readonly [column: string, op: FilterOp, value: string]

export const TABS = ['details', 'rows'] as const
export type DetailTab = (typeof TABS)[number]

export const DIRECTIONS = ['asc', 'desc'] as const
export type Direction = (typeof DIRECTIONS)[number]

export interface SchemaSearch {
  /** The name filter of the list or the diagram. */
  readonly q?: string | undefined
  /** The schema the list is narrowed to. */
  readonly schema?: string | undefined
  /** The selected object: its kind, then the parts of its canonical key. */
  readonly object?: readonly string[] | undefined
  /** `rows` opens the row browser of the selected object; `details` is the default. */
  readonly tab?: DetailTab | undefined
  /** The column the row browser sorts by (matched against the object's columns before it is used). */
  readonly sort?: string | undefined
  readonly dir?: Direction | undefined
  readonly filter?: readonly UrlFilter[] | undefined
}

const CONTROL = /[\p{Cc}\p{Cf}]/u
const KIND = /^[a-z][a-z0-9_.:-]{0,63}$/

/** Text a link holds: the router reads `?q=2024` as a number and `?q=true` as a boolean; both come back as text. */
function textOf(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw)
  return undefined
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' ? allowed.find((candidate) => candidate === value) : undefined
}

function nameOf(raw: unknown): string | undefined {
  const text = textOf(raw)
  return text !== undefined &&
    text.length > 0 &&
    text.length <= NAME_MAX &&
    !text.includes('\u0000')
    ? text
    : undefined
}

/**
 * The name filter: text with a control or format character (bidirectional
 * overrides included), or longer than the bound, is dropped, as in the
 * targets list.
 */
function queryOf(raw: unknown): string | undefined {
  const text = textOf(raw)
  return text !== undefined && text.length > 0 && text.length <= SEARCH_Q_MAX && !CONTROL.test(text)
    ? text
    : undefined
}

/**
 * The object's key from a link: `[kind, ...key]`. The kind has the shape the
 * contract allows; the key has one to eight parts, each bounded and free of
 * NUL (a name with hidden characters is still a name, and is shown with them
 * marked); the first two parts, schema and name, are not empty (the third
 * of a function is its argument list, which may be).
 */
function objectOf(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > OBJECT_KEY_MAX_PARTS + 1) {
    return undefined
  }
  const parts: string[] = []
  for (const [index, part] of raw.entries()) {
    if (typeof part !== 'string') return undefined
    if (index === 0) {
      if (!KIND.test(part)) return undefined
    } else if (
      part.length > NAME_MAX ||
      part.includes('\u0000') ||
      (index <= 2 && part.length === 0)
    ) {
      return undefined
    }
    parts.push(part)
  }
  return parts
}

function filtersOf(raw: unknown): readonly UrlFilter[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILTERS) return undefined
  const filters: UrlFilter[] = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2 || entry.length > 3) return undefined
    const [column, op, value] = entry as unknown[]
    // Inside the list the router has not turned anything into a number: only text is a column.
    const name = typeof column === 'string' ? nameOf(column) : undefined
    if (name === undefined || !isFilterOp(op)) return undefined
    if (isNullOp(op)) {
      filters.push([name, op, ''])
      continue
    }
    if (typeof value !== 'string' || value.length > FILTER_VALUE_MAX || value.includes('\u0000')) {
      return undefined
    }
    filters.push([name, op, value])
  }
  return filters
}

export function schemaSearch(raw: Readonly<Record<string, unknown>>): SchemaSearch {
  const object = objectOf(raw['object'])
  const sort = object === undefined ? undefined : nameOf(raw['sort'])
  return {
    q: queryOf(raw['q']),
    schema: nameOf(raw['schema']),
    object,
    // What belongs to the row browser means nothing without an object.
    tab: object === undefined ? undefined : oneOf(TABS, raw['tab']),
    sort,
    dir: sort === undefined ? undefined : oneOf(DIRECTIONS, raw['dir']),
    filter: object === undefined ? undefined : filtersOf(raw['filter']),
  }
}

/** The object a search selects. */
export function objectKeyOf(search: SchemaSearch): ObjectKey | undefined {
  const [kind, ...key] = search.object ?? []
  return kind === undefined || key.length === 0 ? undefined : { kind, key }
}

/** The `object` value of a link for an object. */
export function objectParam(object: ObjectKey): readonly string[] {
  return [object.kind, ...object.key]
}

/**
 * The search as the router takes it: only keys with a value, and nothing the
 * object does not need (a sort or a filter without an object means nothing).
 */
export function cleanSearch(search: SchemaSearch): SchemaSearch {
  const hasObject = search.object !== undefined
  const sorted = hasObject && search.sort !== undefined
  return {
    ...(search.q === undefined ? {} : { q: search.q }),
    ...(search.schema === undefined ? {} : { schema: search.schema }),
    ...(hasObject ? { object: search.object } : {}),
    ...(hasObject && search.tab !== undefined && search.tab !== 'details'
      ? { tab: search.tab }
      : {}),
    ...(sorted ? { sort: search.sort } : {}),
    ...(sorted && search.dir !== undefined && search.dir !== 'asc' ? { dir: search.dir } : {}),
    ...(hasObject && search.filter !== undefined && search.filter.length > 0
      ? { filter: search.filter }
      : {}),
  }
}

/** What the panel of a selected object shows: the tab, and the row browser's sort and filters. */
export interface PanelState {
  readonly tab: DetailTab
  readonly sort: string | undefined
  readonly dir: Direction | undefined
  readonly filter: readonly UrlFilter[]
}

export const DEFAULT_PANEL_STATE: PanelState = {
  tab: 'details',
  sort: undefined,
  dir: undefined,
  filter: [],
}

export function panelStateOf(search: SchemaSearch): PanelState {
  return {
    tab: search.tab ?? 'details',
    sort: search.sort,
    dir: search.dir,
    filter: search.filter ?? [],
  }
}

/** The search with the panel's state written into it. */
export function withPanelState(search: SchemaSearch, state: PanelState): SchemaSearch {
  return {
    ...search,
    tab: state.tab === 'details' ? undefined : state.tab,
    sort: state.sort,
    dir: state.sort === undefined ? undefined : state.dir,
    filter: state.filter.length === 0 ? undefined : state.filter,
  }
}

/** The `/schema/<kind>` page that lists an object kind of the contract, if it has one. */
const KIND_PAGE: ReadonlyMap<string, SchemaKind> = new Map([
  ['schema', 'schemas'],
  ['table', 'tables'],
  ['view', 'views'],
  ['materialized_view', 'materialized-views'],
  ['function', 'functions'],
  ['procedure', 'functions'],
  ['trigger', 'triggers'],
  ['type', 'types'],
  ['sequence', 'sequences'],
  ['extension', 'extensions'],
  ['index', 'indexes'],
  ['policy', 'policies'],
])

export function pageOfKind(kind: string): SchemaKind | undefined {
  return KIND_PAGE.get(kind)
}

interface TargetPathParts {
  readonly product: string
  readonly project: string
  readonly environment: string
}

/** `/t/…/schema/<page>` with the search; the path parts are the validated slugs of the route. */
export function schemaPageHref(
  target: TargetPathParts,
  page: SchemaKind,
  search: SchemaSearch = {},
): string {
  return `${targetHref(target, '/schema')}/${page}${defaultStringifySearch(cleanSearch(search))}`
}

/**
 * The link to an object, on the page of its kind, or `undefined` for a kind
 * that has no page. Names travel in the search as JSON text, percent-encoded
 * by the router's own serializer, never in the path.
 */
export function objectHref(
  target: TargetPathParts,
  object: ObjectKey,
  extra: Partial<SchemaSearch> = {},
): string | undefined {
  const page = pageOfKind(object.kind)
  if (page === undefined) return undefined
  return schemaPageHref(target, page, { ...extra, object: objectParam(object) })
}
