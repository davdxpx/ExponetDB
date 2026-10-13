// Derived from supabase/supabase packages/ui/src/components/StatusIcon.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import * as React from 'react'

import { cn } from './lib/utils.ts'

export type StatusVariant = 'default' | 'info' | 'success' | 'warning' | 'destructive'

/** The accessible name of each variant: what the icon says when it is read aloud. */
const DEFAULT_LABELS: Record<StatusVariant, string> = {
  default: 'Information',
  info: 'Information',
  success: 'Success',
  warning: 'Warning',
  destructive: 'Error',
}

type Glyph = 'info' | 'check' | 'triangle' | 'circle'

/**
 * Each variant has its own shape as well as its own color (circle with "i", check
 * mark, triangle with "!", circle with "!"), so color is never the only signal.
 */
const GLYPH_BY_VARIANT: Record<StatusVariant, Glyph> = {
  default: 'info',
  info: 'info',
  success: 'check',
  warning: 'triangle',
  destructive: 'circle',
}

const BADGE_CLASSES: Record<StatusVariant, string> = {
  default: 'bg-foreground-lighter text-background',
  info: 'bg-info text-info-foreground',
  success: 'bg-success text-success-foreground',
  warning: 'bg-warning-600 text-warning-200',
  destructive: 'bg-destructive-600 text-destructive-200',
}

const BARE_CLASSES: Record<StatusVariant, string> = {
  default: 'text-foreground-lighter',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
}

function GlyphPaths({ glyph }: { glyph: Glyph }) {
  switch (glyph) {
    case 'check':
      return (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={3}
          d="m4.5 12.75 6 6 9-13.5"
        />
      )
    case 'triangle':
      return (
        <path
          fillRule="evenodd"
          d="M6.701 2.25c.577-1 2.02-1 2.598 0l5.196 9a1.5 1.5 0 0 1-1.299 2.25H2.804a1.5 1.5 0 0 1-1.3-2.25l5.197-9ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 1 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      )
    case 'circle':
      return (
        <path
          fillRule="evenodd"
          d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14ZM8 4a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      )
    case 'info':
      return (
        <path
          fillRule="evenodd"
          d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM9 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM6.75 8a.75.75 0 0 0 0 1.5h.75v1.75a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8.25 8h-1.5Z"
          clipRule="evenodd"
        />
      )
  }
}

export interface StatusIconProps extends Omit<React.ComponentPropsWithoutRef<'svg'>, 'children'> {
  variant?: StatusVariant
  /** Draws the bare glyph without the colored square behind it. */
  hideBackground?: boolean
  /** Accessible name. Defaults to the name of the variant ("Warning", "Error", …). */
  label?: string
  /**
   * Hides the icon from assistive technology. Use it only when text next to the icon says
   * the same thing (for example "Failed"); otherwise the icon needs its label.
   */
  decorative?: boolean
}

/** A status glyph with an accessible name. The glyph differs by shape, not only by color. */
export const StatusIcon = React.forwardRef<SVGSVGElement, StatusIconProps>(
  (
    { variant = 'default', hideBackground = false, label, decorative = false, className, ...props },
    ref,
  ) => {
    const glyph = GLYPH_BY_VARIANT[variant]
    const stroked = glyph === 'check'
    const shared = {
      ref,
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: stroked ? '0 0 24 24' : '0 0 16 16',
      fill: stroked ? 'none' : 'currentColor',
      stroke: stroked ? 'currentColor' : undefined,
      'data-status': variant,
      ...props,
      className: cn(
        hideBackground
          ? ['w-3 h-3', BARE_CLASSES[variant]]
          : ['w-4 h-4 p-0.5 rounded-sm', BADGE_CLASSES[variant]],
        className,
      ),
    }

    if (decorative) {
      return (
        <svg {...shared} aria-hidden="true">
          <GlyphPaths glyph={glyph} />
        </svg>
      )
    }

    return (
      <svg {...shared} role="img" aria-label={label ?? DEFAULT_LABELS[variant]}>
        <GlyphPaths glyph={glyph} />
      </svg>
    )
  },
)
StatusIcon.displayName = 'StatusIcon'
