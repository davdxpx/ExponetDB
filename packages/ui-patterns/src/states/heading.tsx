import type { HTMLAttributes, ReactNode } from 'react'

/** The heading levels a state or card may use; `h1` belongs to the page. */
export type HeadingLevel = 2 | 3 | 4 | 5 | 6

export interface StateHeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  /** The heading level, so the component fits the outline of the page it sits in. Default 3. */
  level?: HeadingLevel
}

/** A heading whose level is chosen by the caller. */
export function StateHeading({ level = 3, ...props }: StateHeadingProps): ReactNode {
  const Tag = `h${level}` as const
  return <Tag {...props} />
}
