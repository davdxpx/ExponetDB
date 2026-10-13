// Derived from supabase/supabase packages/ui-patterns/src/TextLink/index.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { ChevronRight } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'

import { isAppPath, useLinkComponent } from '../seams/index.ts'

// The link patterns take app paths only (C-26: a link is never built from untrusted
// content); `TextLink` renders anything else as plain text. The check lives in the seams.
export { isAppPath }

export interface TextLinkProps {
  /** The text of the link; it names where the link goes. */
  label: string
  /** An app path the caller built from typed values (`/changes/plans`). External addresses are not supported. */
  href: string
  className?: string
  /** A count shown after the label, `(3)`. Zero is shown. */
  counter?: number
  hasChevron?: boolean
  chevronAnimation?: 'translate' | 'fadeIn'
  onClick?: () => void
}

/**
 * A link to another page of the app, rendered through the link seam. It opens in
 * the same tab: external links are not part of this component. A `href` that is
 * not an app path renders the label as plain text instead of a link.
 */
export function TextLink({
  href,
  label,
  className,
  counter,
  hasChevron = true,
  chevronAnimation = 'translate',
  onClick,
}: TextLinkProps) {
  const Link = useLinkComponent()

  if (!isAppPath(href)) {
    return <span className={cn('text-sm text-foreground-light', className)}>{label}</span>
  }

  const content = (
    <span className="group flex items-center gap-1">
      <span>{label}</span>
      {counter !== undefined && (
        <span className="text-xs flex items-center justify-center text-foreground-lighter group-hover/text-link:text-foreground">
          ({counter})
        </span>
      )}
      {hasChevron && (
        <span
          aria-hidden="true"
          className={cn(
            'transition-all group-hover:ml-0.5 motion-reduce:transition-none',
            chevronAnimation === 'fadeIn' && 'opacity-0 group-hover:opacity-100',
          )}
        >
          <ChevronRight size={14} strokeWidth={2} />
        </span>
      )}
    </span>
  )

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'group/text-link inline-block cursor-pointer text-sm text-foreground-light hover:text-foreground focus-ring focus-visible:rounded-xs focus-visible:text-foreground',
        className,
      )}
    >
      {content}
    </Link>
  )
}
