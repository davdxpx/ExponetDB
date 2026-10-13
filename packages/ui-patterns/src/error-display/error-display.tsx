// Derived from supabase/supabase packages/ui-patterns/src/ErrorDisplay/ErrorDisplay.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Card, CardHeader, cn, StatusIcon } from '@exponetdb/ui'
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useId } from 'react'

import { type HeadingLevel, StateHeading } from '../states/heading.tsx'

export interface ErrorDisplayProps extends Omit<ComponentPropsWithoutRef<'div'>, 'title'> {
  /**
   * What failed, in the header.
   * @example "Could not read backup inventory"
   */
  title: string
  /**
   * The reason, in a monospace block. Shown as text, never as markup.
   * @example "The target did not answer within 5 seconds."
   */
  message: string
  /** The stable error code, so a person can quote it to support: `TARGET_UNREACHABLE`. */
  code?: string
  /** Replaces the warning icon of the header. Decorative. */
  icon?: ReactNode
  /** Buttons for what to do next: a retry, a link to the documentation. */
  actions?: ReactNode
  /** The heading level of the title. Default 3. */
  headingLevel?: HeadingLevel
  /** Notes between the reason and the footer, such as troubleshooting steps. */
  children?: ReactNode
  className?: string
}

/**
 * The frame of an error that names what failed, why and what to do next: a
 * header, the reason, optional notes, and a footer with the stable code and the
 * actions. It is announced to assistive technology as an alert. `FailedReadState`
 * builds the failed-read state on it.
 */
export const ErrorDisplay = forwardRef<HTMLDivElement, ErrorDisplayProps>(
  (
    { title, message, code, icon, actions, headingLevel = 3, children, className, ...props },
    ref,
  ) => {
    const titleId = useId()
    return (
      <Card
        ref={ref}
        role="alert"
        aria-labelledby={titleId}
        className={cn('rounded-lg border border-default', className)}
        {...props}
      >
        <CardHeader className="flex-row items-center gap-2.5 space-y-0 p-3">
          <span aria-hidden="true">{icon ?? <StatusIcon variant="warning" decorative />}</span>
          <StateHeading
            id={titleId}
            level={headingLevel}
            className="mt-0 text-sm font-medium text-foreground"
          >
            {title}
          </StateHeading>
        </CardHeader>

        <div className="border-y border-warning-500 bg-warning-200 px-4 py-3">
          <pre className="font-mono text-xs break-words whitespace-pre-wrap text-warning-600">
            {message}
          </pre>
        </div>

        {children}

        {(code !== undefined || actions !== undefined) && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-default px-3 py-2">
            <span className="text-sm text-foreground-light">
              {code !== undefined && (
                <>
                  Error code <code className="font-mono text-foreground">{code}</code>
                </>
              )}
            </span>
            {actions}
          </div>
        )}
      </Card>
    )
  },
)

ErrorDisplay.displayName = 'ErrorDisplay'
