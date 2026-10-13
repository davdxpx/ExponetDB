// Derived from supabase/supabase packages/ui-patterns/src/EmptyStatePresentational/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { LucideIcon } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import { createElement, isValidElement, type ReactNode } from 'react'

import { type HeadingLevel, StateHeading } from '../states/heading.tsx'

export interface EmptyStateProps {
  /** A Lucide icon component or a ready element. Decorative: the title says what it says. */
  icon?: LucideIcon | ReactNode
  title: string
  description?: ReactNode
  /** Typically the action that fills the list: a button or a link. */
  children?: ReactNode
  className?: string
  iconSize?: number
  iconClassName?: string
  contentClassName?: string
  /** The heading level of the title. Default 3. */
  headingLevel?: HeadingLevel
}

function renderIcon(icon: LucideIcon | ReactNode, size: number, className?: string): ReactNode {
  if (icon === undefined || icon === null) return null
  // A ready element is rendered as it is.
  if (isValidElement(icon)) return icon
  // A component type (a function, or a forwardRef object): instantiate it.
  if (typeof icon === 'function' || (typeof icon === 'object' && '$$typeof' in icon)) {
    return createElement(icon as LucideIcon, {
      size,
      strokeWidth: 1.5,
      className: cn('text-foreground-muted', className),
    })
  }
  return icon
}

/**
 * The state of a list that was read successfully and holds nothing, with a
 * dashed frame, an optional icon, a title, a description and the action that
 * fills it. Use it only after a successful read: a failed or partial read has
 * its own states (`ReadableView`), and "no data" must never stand for "could
 * not read".
 */
export function EmptyState({
  icon,
  title,
  description,
  children,
  className,
  iconSize = 24,
  iconClassName,
  contentClassName,
  headingLevel = 3,
}: EmptyStateProps): ReactNode {
  const iconNode = renderIcon(icon, iconSize, iconClassName)
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex w-full flex-col items-center gap-y-3 rounded-lg border border-dashed bg-surface-100 px-4 py-10',
        className,
      )}
    >
      <div className="flex flex-col items-center gap-y-3">
        {iconNode !== null && <span aria-hidden="true">{iconNode}</span>}
        <div
          className={cn('flex flex-col items-center text-balance text-center', contentClassName)}
        >
          <StateHeading level={headingLevel} className="text-base font-medium text-foreground">
            {title}
          </StateHeading>
          {description !== undefined && (
            <div className="max-w-[640px] text-sm text-foreground-light">{description}</div>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}
