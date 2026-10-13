import type { ReactNode } from 'react'

/** The `h2` of one section of the account page. */
export function SectionHeading({
  id,
  children,
}: {
  readonly id: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <h2 id={id} className="text-lg font-medium text-foreground">
      {children}
    </h2>
  )
}
