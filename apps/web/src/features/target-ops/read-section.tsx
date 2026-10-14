import {
  type HeadingLevel,
  NotPermittedState,
  ReadableView,
  type ReadMeta,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { classifyFailure } from '../../lib/query/errors.ts'
import { toReadable } from '../../lib/query/readable.ts'

/** The part of a query result a section needs (a `useQuery` result, or a flattened paged one). */
export interface SectionQuery<T> {
  readonly data: T | undefined
  readonly error: unknown
  readonly isError: boolean
  readonly dataUpdatedAt: number
  readonly isFetching: boolean
  readonly refetch: () => unknown
}

export interface ReadSectionProps<T> {
  readonly query: SectionQuery<T>
  /** What is read, as a noun phrase that works after "no": "audit events". */
  readonly what: string
  /** The permission a refused read names ("audit.read"): a refusal is a named state, never an empty list. */
  readonly permission: string
  readonly missing?: (value: T) => readonly string[] | undefined
  readonly empty?: { readonly isEmpty: (value: T) => boolean; readonly content?: ReactNode }
  readonly ready: (value: T, meta: ReadMeta) => ReactNode
  readonly headingLevel?: HeadingLevel
}

/**
 * One read of a target page, shown truthfully (C-28): loading, failed (with
 * its code and a retry, never as empty), stale with its age, partial naming
 * what is missing, empty only after a successful read, ready. A read the
 * server refused for lack of a permission is the named "not permitted"
 * state that says which permission is missing.
 */
export function ReadSection<T>(props: ReadSectionProps<T>): ReactNode {
  const { query } = props
  if (
    query.data === undefined &&
    query.isError &&
    classifyFailure(query.error).kind === 'not_permitted'
  ) {
    return (
      <NotPermittedState
        what={props.what}
        permission={props.permission}
        headingLevel={props.headingLevel ?? 3}
      />
    )
  }
  const refetch = () => void query.refetch()
  return (
    <ReadableView
      readable={toReadable(query, props.missing === undefined ? {} : { missing: props.missing })}
      what={props.what}
      onRetry={refetch}
      onRefresh={refetch}
      busy={query.isFetching}
      headingLevel={props.headingLevel ?? 3}
      {...(props.empty === undefined ? {} : { empty: props.empty })}
      ready={props.ready}
    />
  )
}
