import { Card, CardContent, CardFooter, cn, Label } from '@exponetdb/ui'
import { type ReactNode, useId } from 'react'

/**
 * The pieces of the account pages, laid out as Studio lays out its account
 * pages (information-architecture.md §2): each section is a title (an `h2`)
 * with a line about it, above a card; in the card each setting is a row with
 * its name on the left and its value or control on the right; the actions
 * that save a card's settings are in its footer, on the right.
 */

/** The `h2` of one section of the account page. */
export function SectionHeading({
  id,
  children,
}: {
  readonly id: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <h2 id={id} className="text-base font-medium text-foreground">
      {children}
    </h2>
  )
}

/** A section: its title and description above its content (usually an `AccountCard`). */
export function AccountSection({
  title,
  description,
  aside,
  children,
}: {
  readonly title: ReactNode
  readonly description?: ReactNode
  /** Beside the title on the right, for an action that concerns the whole section. */
  readonly aside?: ReactNode
  readonly children: ReactNode
}): ReactNode {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <SectionHeading id={headingId}>{title}</SectionHeading>
          {description === undefined ? null : (
            <p className="text-sm text-foreground-light">{description}</p>
          )}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** The card of a section; `footer` holds the actions, on the right. */
export function AccountCard({
  children,
  footer,
  className,
}: {
  readonly children: ReactNode
  readonly footer?: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <Card className={className}>
      {children}
      {footer === undefined ? null : (
        <CardFooter className="flex-wrap justify-end gap-2 border-t">{footer}</CardFooter>
      )}
    </Card>
  )
}

/**
 * A row of a card: the name of the setting (a `label` for `htmlFor`) and a
 * line about it on the left, the value or the control on the right; stacked
 * on a phone.
 */
export function CardRow({
  label,
  htmlFor,
  description,
  descriptionId,
  children,
  className,
}: {
  readonly label: ReactNode
  readonly htmlFor?: string
  readonly description?: ReactNode
  /** The id of the description, so a control can point at it with `aria-describedby`. */
  readonly descriptionId?: string
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return (
    <CardContent className={cn('grid gap-2 md:grid-cols-12 md:gap-6', className)}>
      <div className="flex min-w-0 flex-col gap-1 md:col-span-4">
        {htmlFor === undefined ? (
          <span className="text-sm text-foreground-light">{label}</span>
        ) : (
          <Label htmlFor={htmlFor} className="text-sm font-normal text-foreground-light">
            {label}
          </Label>
        )}
        {description === undefined ? null : (
          <p id={descriptionId} className="text-xs text-foreground-lighter">
            {description}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2 md:col-span-8">{children}</div>
    </CardContent>
  )
}
