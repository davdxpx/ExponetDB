import type { NowInput, Readable } from '@exponetdb/ui-patterns'

/**
 * The text diff viewer's props (light module; the implementation is
 * `text-diff.tsx`, CodeMirror's merge view in a shadow root).
 */

/** The largest text per side the viewer compares in the browser (UTF-16 code units). */
export const MAX_DIFF_CHARACTERS = 1_000_000

export interface TextDiffViewProps {
  /** The accessible name of the comparison, e.g. "up.sql: draft against applied". */
  label: string
  /** The left side. Compare, never edit: both sides are read-only. */
  before: string
  after: string
  /** Default "Before". */
  beforeLabel?: string
  /** Default "After". */
  afterLabel?: string
  /** Highlight both sides as PostgreSQL. Default true. */
  sql?: boolean
  /** Collapse long runs of unchanged lines (a button shows them all). Default true. */
  collapseUnchanged?: boolean
  /** Wrap long lines. Default true. */
  wrap?: boolean
  /** Height at most this many lines, then the view scrolls. Default 40. */
  maxLines?: number
  /** Class names of the outer element. */
  className?: string
}

/** The two texts a read produces. */
export interface TextDiffSides {
  readonly before: string
  readonly after: string
}

/**
 * Props of `ReadableTextDiff`: the viewer behind the truthful-state union
 * (C-28). A failed read shows the failure and never a diff, a loading read a
 * skeleton, a stale or partial read the diff under its banner.
 */
export interface ReadableTextDiffProps extends Omit<TextDiffViewProps, 'before' | 'after'> {
  readable: Readable<TextDiffSides>
  /** What is read, as a noun phrase that works after "no": "migration text". */
  what: string
  onRetry?: () => void
  onRefresh?: () => void
  /** A read is running: retry and refresh show it is busy. */
  busy?: boolean
  now?: NowInput
}
