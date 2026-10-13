import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

export type { ClassValue }

/**
 * Tailwind class merger of the design system. On top of the default Tailwind
 * scales it knows the named steps of the tokens: the `card` and `content`
 * spacing (`p-card`, `gap-content`), the `panel` and `item` radii and the
 * `enter` and `move` easings. Each replaces its default sibling (`p-4`,
 * `rounded-md`, `ease-in`) and is replaced by it.
 *
 * Custom utilities of the token package (`focus-ring`, `control-surface-shadows`,
 * `raised-control-surface`, `hit-area-1`) belong to no Tailwind group, so the
 * merger leaves them alone. Custom color names (`text-foreground-light`,
 * `bg-surface-100`, `border-control`) fall into the generic color groups and
 * the last one wins, as intended.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ['card', 'content'],
      radius: ['panel', 'item'],
      ease: ['enter', 'move'],
    },
  },
})

/** Joins class names and lets the last of conflicting Tailwind utilities win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
