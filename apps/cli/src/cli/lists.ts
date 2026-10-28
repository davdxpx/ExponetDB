import type { ApiError, Operations } from '@exponetdb/sdk'
import type { CommandResult } from '../output/model.ts'
import { exitFor } from './exit.ts'
import type { FlagSpec, Remote } from './types.ts'

/**
 * Paged listings ([`15-cli/README.md` §4](../../../../exponetdb-docs/15-cli/README.md#4-output-contract-exponetdbcli-outputv1)):
 * `--limit` items (default 50), `--all` for every page (at most 10,000
 * items), `--cursor` to continue. A page that fails after others arrived
 * makes the result partial: the items shown are never the complete list,
 * the error is reported and the exit code is not 0.
 */
export const LIST_FLAGS: readonly FlagSpec[] = [
  { name: 'limit', type: 'number', description: 'Items to show (1 to 10000).', default: 50 },
  { name: 'all', type: 'boolean', description: 'Every page (at most 10000 items).' },
  {
    name: 'cursor',
    type: 'string',
    placeholder: 'cursor',
    description: 'Continue after a previous page.',
  },
]

export type ListId = {
  [K in keyof Operations]: Operations[K]['response'] extends {
    readonly items: ReadonlyArray<unknown>
    readonly nextCursor: string | null
  }
    ? K
    : never
}[keyof Operations]

type ItemOf<Id extends ListId> = Operations[Id]['response']['items'][number]

export interface Listing<T> {
  readonly items: T[]
  readonly partial: boolean
  readonly error?: ApiError
  /** The cursor to continue from (null when the list ended). */
  readonly nextCursor: string | null
}

export async function collect<Id extends ListId>(
  remote: Remote,
  id: Id,
  params: Operations[Id]['params'] | undefined,
  query: Omit<Operations[Id]['query'], 'limit' | 'cursor'>,
  flags: Readonly<Record<string, unknown>>,
  pageMax = 200,
): Promise<Listing<ItemOf<Id>>> {
  const max =
    flags['all'] === true ? 10_000 : Math.min(10_000, Math.max(1, Number(flags['limit'] ?? 50)))
  const cursor = typeof flags['cursor'] === 'string' ? flags['cursor'] : undefined
  const items: ItemOf<Id>[] = []
  let nextCursor: string | null = null
  const q = {
    ...query,
    limit: Math.min(pageMax, max),
    ...(cursor === undefined ? {} : { cursor }),
  } as unknown as Operations[Id]['query']
  for await (const page of remote.sdk.pages(id, params, q)) {
    if (!page.ok) {
      return { items, partial: items.length > 0, error: page.error, nextCursor }
    }
    const value = page.value as unknown as { items: ItemOf<Id>[]; nextCursor: string | null }
    for (const item of value.items) {
      if (items.length < max) items.push(item)
    }
    nextCursor = value.nextCursor
    if (items.length >= max) break
  }
  return { items, partial: false, nextCursor: items.length >= max ? nextCursor : null }
}

/**
 * A listing's failure as a result. A listing that failed after some pages arrived keeps the
 * items that did and is marked partial; one that failed before any item arrived is the typed
 * error alone, with no table, no count and no `data` (an empty list would read as "none",
 * TC-030).
 */
export function listingFailure<T>(
  command: string,
  listing: Listing<T>,
  fallback: Omit<CommandResult, 'command' | 'status' | 'exitCode' | 'error'>,
): CommandResult | undefined {
  if (listing.error === undefined) return undefined
  const e = listing.error
  const kept =
    listing.items.length === 0
      ? { blocks: [] }
      : { ...fallback, partial: listing.partial, items: listing.items }
  return {
    ...kept,
    command,
    status: 'error',
    exitCode: exitFor(e.code),
    error: {
      code: e.code,
      message: e.message ?? 'The server refused the request.',
      ...(e.remediation === undefined ? {} : { remediation: e.remediation }),
      ...(e.details === undefined ? {} : { details: e.details }),
    },
    ...(e.requestId === null ? {} : { requestId: e.requestId }),
  }
}

type ResponseOf<Id extends keyof Operations> = Operations[Id]['response']

/** The fields of a response that hold a list. */
export type ArrayField<R> = {
  [K in keyof R]: R[K] extends ReadonlyArray<unknown> ? K : never
}[keyof R] &
  string

export type ElementOf<R, K extends keyof R> = R[K] extends ReadonlyArray<infer T> ? T : never

/**
 * A paged listing whose items are in a named field (`clusters`, `backups`,
 * `runs`, …) next to facts of the whole answer (protection, counts, source
 * and time): the items of every page asked for, with the facts of the
 * first page. The same bounds and partial reporting as `collect`.
 */
export async function collectField<
  Id extends keyof Operations,
  K extends ArrayField<ResponseOf<Id>>,
>(
  remote: Remote,
  id: Id,
  params: Operations[Id]['params'] | undefined,
  query: Readonly<Record<string, unknown>>,
  flags: Readonly<Record<string, unknown>>,
  field: K,
  pageMax = 200,
): Promise<Listing<ElementOf<ResponseOf<Id>, K>> & { readonly first: ResponseOf<Id> | undefined }> {
  type Item = ElementOf<ResponseOf<Id>, K>
  const max =
    flags['all'] === true ? 10_000 : Math.min(10_000, Math.max(1, Number(flags['limit'] ?? 50)))
  const cursor = typeof flags['cursor'] === 'string' ? flags['cursor'] : undefined
  const items: Item[] = []
  let first: ResponseOf<Id> | undefined
  let nextCursor: string | null = null
  const q = {
    ...query,
    limit: Math.min(pageMax, max),
    ...(cursor === undefined ? {} : { cursor }),
  } as unknown as Operations[Id]['query']
  for await (const page of remote.sdk.pages(id, params, q)) {
    if (!page.ok) {
      return { items, partial: items.length > 0, error: page.error, nextCursor, first }
    }
    const value = page.value as ResponseOf<Id>
    first ??= value
    for (const item of value[field] as unknown as readonly Item[]) {
      if (items.length < max) items.push(item)
    }
    nextCursor = (value as { readonly nextCursor?: string | null }).nextCursor ?? null
    if (items.length >= max) break
  }
  return { items, partial: false, nextCursor: items.length >= max ? nextCursor : null, first }
}
