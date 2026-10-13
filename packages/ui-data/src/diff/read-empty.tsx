import { EmptyState, type HeadingLevel, type ReadMeta } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'

export interface ReadEmptyProps {
  readonly title: string
  /** What was found none of, as a plural noun: "settings or grants", "schema changes". */
  readonly noun: string
  readonly meta: ReadMeta
  readonly headingLevel?: HeadingLevel
}

/**
 * The empty state of a list, worded by the state of the read (C-28): a ready
 * read says the read succeeded, a stale read says the last successful read
 * found none, and a partial read says only that the part that was read has
 * none, because what is missing may be what was asked for.
 */
export function ReadEmpty({ title, noun, meta, headingLevel }: ReadEmptyProps): ReactNode {
  const description =
    meta.state === 'stale'
      ? `The last successful read found no ${noun}.`
      : meta.state === 'partial'
        ? `The part that was read has no ${noun}. The notice above says what is missing.`
        : `The read succeeded and found no ${noun}.`
  return <EmptyState title={title} description={description} headingLevel={headingLevel} />
}
