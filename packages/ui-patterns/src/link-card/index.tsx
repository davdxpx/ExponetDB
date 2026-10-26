import { ArrowUpRight } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import type { AnchorHTMLAttributes, ReactNode } from 'react'

import { useLinkComponent } from '../seams/index.ts'

/**
 * What the card stands for, drawn as a slim bar on its leading edge and never as the only
 * signal (the card's own text names the state). `production` uses the reserved token.
 */
export type LinkCardTone = 'neutral' | 'critical' | 'warning' | 'healthy' | 'production' | 'info'

const TONE_BAR: Record<LinkCardTone, string> = {
  neutral: 'before:bg-transparent',
  critical: 'before:bg-destructive',
  warning: 'before:bg-warning',
  healthy: 'before:bg-state-healthy',
  production: 'before:bg-production',
  info: 'before:bg-info',
}

export type LinkCardProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children'> & {
  /** An app path the caller built from typed values; the whole card is this one link. */
  readonly href: string
  readonly children: ReactNode
  readonly tone?: LinkCardTone
  /** Hide the arrow in the corner (a dense list of cards). */
  readonly bare?: boolean
}

/**
 * A card that is a link, all of it: one `<a>` through the link seam, so a click anywhere on the
 * card navigates, the middle button and "Open in new tab" work, and the keyboard reaches it once.
 * The card holds no other interactive element (a link inside a link is invalid and unreachable);
 * a card with more than one action is a `Card` with real buttons instead. Hover lifts it by one
 * pixel and strengthens its edge, a press settles it, focus draws the ring around the whole card;
 * all of it stands still under `prefers-reduced-motion`.
 */
export function LinkCard({
  href,
  children,
  tone = 'neutral',
  bare = false,
  className,
  ...props
}: LinkCardProps): ReactNode {
  const Link = useLinkComponent()
  return (
    <Link
      href={href}
      data-slot="link-card"
      data-tone={tone}
      className={cn(
        'group/link-card relative isolate flex min-w-0 flex-col overflow-hidden rounded-lg border bg-surface-100 text-card-foreground shadow-xs',
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[""]',
        TONE_BAR[tone],
        'transition-[transform,box-shadow,border-color,background-color] duration-150 ease-out',
        'hover:-translate-y-px hover:border-strong hover:bg-surface-200/60 hover:shadow-md',
        'active:translate-y-0 active:shadow-xs',
        'motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        'focus-ring',
        className,
      )}
      {...props}
    >
      {children}
      {bare ? null : (
        <ArrowUpRight
          aria-hidden="true"
          strokeWidth={1.5}
          className="pointer-events-none absolute top-3 right-3 size-4 text-foreground-muted opacity-60 transition-[opacity,transform] duration-150 group-hover/link-card:translate-x-0.5 group-hover/link-card:-translate-y-0.5 group-hover/link-card:text-foreground group-hover/link-card:opacity-100 group-focus-visible/link-card:opacity-100 motion-reduce:transition-none motion-reduce:group-hover/link-card:translate-x-0 motion-reduce:group-hover/link-card:translate-y-0"
        />
      )}
    </Link>
  )
}
