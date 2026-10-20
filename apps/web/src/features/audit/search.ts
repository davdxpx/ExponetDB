import type { Query } from '../../lib/api/client.ts'

/**
 * The filters of the audit search as URL parameters (`/audit?actor=…`):
 * each value is kept only when it has the exact shape the API takes, so a
 * link can never put anything else into a request or onto the page. A value
 * that does not fit is dropped (the search runs without it), never echoed.
 */
export interface AuditSearch {
  readonly actor?: 'self' | 'any'
  /** Only events made by this identity (`idn_…`); with `actor=self` both apply. */
  readonly identity?: string
  readonly client?: string
  readonly grant?: string
  readonly action?: string
  readonly result?: 'succeeded' | 'failed' | 'denied'
  readonly target?: string
  readonly from?: string
  readonly to?: string
}

export const AUDIT_FILTERS = [
  'actor',
  'identity',
  'client',
  'grant',
  'action',
  'result',
  'target',
  'from',
  'to',
] as const satisfies readonly (keyof AuditSearch)[]

const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const IDENTITY = new RegExp(`^idn_${ULID}$`)
const CLIENT = new RegExp(`^cli_${ULID}$`)
const GRANT = new RegExp(`^grt_${ULID}$`)
const TARGET = new RegExp(`^tgt_${ULID}$`)
/** `<domain>.<verb>` and deeper, lower case: `migration.apply`, `oauth.grant.revoke`. */
const ACTION = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,5}$/
/** RFC 3339 UTC with a `Z`, as the API takes it. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/

export function isAuditTime(value: string): boolean {
  return TIME.test(value) && Number.isFinite(Date.parse(value))
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}

/** The validated filters of a search object (the router's `validateSearch`). */
export function auditSearch(raw: Readonly<Record<string, unknown>>): AuditSearch {
  const search: {
    -readonly [K in keyof AuditSearch]: AuditSearch[K]
  } = {}
  const actor = text(raw['actor'])
  if (actor === 'self' || actor === 'any') search.actor = actor
  const result = text(raw['result'])
  if (result === 'succeeded' || result === 'failed' || result === 'denied') search.result = result
  const identity = text(raw['identity'])
  if (identity !== undefined && IDENTITY.test(identity)) search.identity = identity
  const client = text(raw['client'])
  if (client !== undefined && CLIENT.test(client)) search.client = client
  const grant = text(raw['grant'])
  if (grant !== undefined && GRANT.test(grant)) search.grant = grant
  const target = text(raw['target'])
  if (target !== undefined && TARGET.test(target)) search.target = target
  const action = text(raw['action'])
  if (action !== undefined && action.length <= 64 && ACTION.test(action)) search.action = action
  const from = text(raw['from'])
  if (from !== undefined && isAuditTime(from)) search.from = from
  const to = text(raw['to'])
  if (to !== undefined && isAuditTime(to)) search.to = to
  return search
}

/** Why one typed filter value is refused, or undefined when it fits (the form's check). */
export function filterProblem(name: keyof AuditSearch, value: string): 'shape' | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return auditSearch({ [name]: trimmed })[name] === undefined ? 'shape' : undefined
}

/** The query of `GET /audit-events` for a search and a page cursor. */
export function auditQuery(
  search: AuditSearch,
  cursor: string | undefined,
  limit: number,
): Query<'searchAuditEvents'> {
  return {
    ...search,
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  }
}

/** `/audit` with the validated filters, in a fixed order. */
export function auditHref(search: AuditSearch): string {
  const params = new URLSearchParams()
  const checked = auditSearch(search as Readonly<Record<string, unknown>>)
  for (const name of AUDIT_FILTERS) {
    const value = checked[name]
    if (value !== undefined) params.set(name, value)
  }
  const query = params.toString()
  return query === '' ? '/audit' : `/audit?${query}`
}

export function hasFilters(search: AuditSearch): boolean {
  return AUDIT_FILTERS.some((name) => search[name] !== undefined)
}
