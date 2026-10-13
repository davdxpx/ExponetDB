// Derived from supabase/supabase packages/ui/src/components/FloatingPlate/FloatingPlate.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from './lib/utils.ts'

const ROUNDED = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
} as const

export type FloatingPlateRounded = keyof typeof ROUNDED

export type FloatingPlateProps = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
  /**
   * Plate corner radius. Match or exceed the child control radius
   * (`full` for pill buttons, `lg` for most default buttons).
   * @default 'lg'
   */
  rounded?: FloatingPlateRounded
}

/**
 * Opaque plate behind default Buttons that float over busy content.
 *
 * Default buttons use a translucent fill in dark themes, so code, tables, and
 * gradients show through. Wrap those controls (or clusters) in FloatingPlate
 * so the plate occludes; keep positioning, z-index, and reveal opacity on
 * `className`.
 */
export function FloatingPlate({
  children,
  className,
  rounded = 'lg',
  ...props
}: FloatingPlateProps) {
  return (
    <div className={cn('inline-flex bg-popover', ROUNDED[rounded], className)} {...props}>
      {children}
    </div>
  )
}
