import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

/**
 * Small layout helpers shared by the `ui` demos, and the hostile values the demos of
 * untrusted-content components show. Invisible and direction characters are written
 * with the braced escape, never as raw characters.
 */

/** A wrapping row of items. */
export function Row({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return <div className={cn('flex flex-wrap items-center gap-3', className)}>{children}</div>
}

/** A vertical stack. */
export function Stack({
  children,
  className,
}: {
  readonly children: ReactNode
  readonly className?: string
}): ReactNode {
  return <div className={cn('flex flex-col gap-4', className)}>{children}</div>
}

/** A short caption under or above a specimen. */
export function Caption({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="font-mono text-xs text-foreground-light">{children}</p>
}

/** A specimen with its caption, for grids of variants. */
export function Specimen({
  caption,
  children,
}: {
  readonly caption: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col items-start gap-1.5">
      {children}
      <Caption>{caption}</Caption>
    </div>
  )
}

/**
 * Values that a database, a client or a person can put in a name. A primitive of
 * `@exponetdb/ui` renders them as text (markup stays markup characters) but does not
 * show invisible or direction characters; that is the job of `UntrustedName` and
 * `UntrustedText` from `@exponetdb/ui-patterns`.
 */
export const HOSTILE = {
  /** A right-to-left override that reverses the letters after it. */
  bidi: 'orders\u{202E}gpj.exe',
  /** A zero-width space inside a word. */
  zeroWidth: 'pay\u{200B}ments',
  /** Markup that must stay text. */
  markup: '<img src=x onerror=steal(1)>',
  /** A name with a line break inside it. */
  lineBreak: 'orders\nadmin',
} as const
