import type { Readable, ReadSource } from '@exponetdb/ui-patterns'
import { classifyFailure } from './errors.ts'

/**
 * A query's state as the truthful-state union of the design system (C-28):
 * pending without data is `loading`; a failure without data is `failed`
 * (never an empty list); data whose refresh failed, or older than the
 * staleness limit, is `stale` with its age; data the server marked as
 * incomplete is `partial`; otherwise `ready`. Source and time come from the
 * server's freshness fields when the payload has them, else the time the
 * page received it (`live` while fresh).
 */
export interface QueryLike<T> {
  readonly data: T | undefined
  readonly error: unknown
  readonly isError: boolean
  readonly dataUpdatedAt: number
}

export interface ReadableOptions<T> {
  /** Milliseconds after which received data counts as stale (default 2 sampling intervals = 60 s). */
  readonly staleAfterMs?: number
  /** What the payload says is missing (a partial answer), if anything. */
  readonly missing?: (value: T) => readonly string[] | undefined
  /** The clock (tests). */
  readonly now?: () => number
}

const SOURCES: readonly ReadSource[] = ['live', 'sampled', 'cached', 'agent_reported', 'inferred']

function freshness(value: unknown): { source?: ReadSource; observedAt?: string } {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as Record<string, unknown>
  const nested =
    typeof record['freshness'] === 'object' && record['freshness'] !== null
      ? (record['freshness'] as Record<string, unknown>)
      : record
  const source = SOURCES.find((s) => s === nested['source'])
  const observedAt = typeof nested['observedAt'] === 'string' ? nested['observedAt'] : undefined
  return {
    ...(source === undefined ? {} : { source }),
    ...(observedAt === undefined ? {} : { observedAt }),
  }
}

export function toReadable<T>(query: QueryLike<T>, options: ReadableOptions<T> = {}): Readable<T> {
  const now = options.now ?? Date.now
  const staleAfterMs = options.staleAfterMs ?? 60_000
  if (query.data === undefined) {
    if (query.isError) {
      const failure = classifyFailure(query.error)
      return { state: 'failed', error: { code: failure.code, message: failure.message } }
    }
    return { state: 'loading' }
  }
  const value = query.data
  const told = freshness(value)
  const observedAt = told.observedAt ?? new Date(query.dataUpdatedAt).toISOString()
  const observedMs = Date.parse(observedAt)
  const old = Number.isFinite(observedMs) && now() - observedMs > staleAfterMs
  if (query.isError || old) {
    const failure = query.isError ? classifyFailure(query.error) : undefined
    return {
      state: 'stale',
      value,
      source: told.source ?? 'cached',
      observedAt,
      ...(failure === undefined ? {} : { error: { code: failure.code, message: failure.message } }),
    }
  }
  const missing = options.missing?.(value)
  if (missing !== undefined && missing.length > 0) {
    return { state: 'partial', value, source: told.source ?? 'live', observedAt, missing }
  }
  return { state: 'ready', value, source: told.source ?? 'live', observedAt }
}
