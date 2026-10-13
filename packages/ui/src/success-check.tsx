// Derived from supabase/supabase packages/ui/src/components/SuccessCheck.tsx @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { Check } from '@exponetdb/icons'

import { cn } from './lib/utils.ts'

export interface SuccessCheckProps {
  className?: string
  /** Accessible name. Defaults to "Success". */
  label?: string
  /** Hides the check from assistive technology when text next to it already says "Done". */
  decorative?: boolean
}

/** A check mark in a filled circle: the shape, not only the color, says it succeeded. */
export const SuccessCheck = ({
  className,
  label = 'Success',
  decorative = false,
}: SuccessCheckProps) => (
  <span
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
    className={cn(
      'inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-success bg-success text-success-foreground',
      className,
    )}
  >
    <Check size={12} strokeWidth={3} aria-hidden />
  </span>
)
