import type { ReactNode } from 'react'

/**
 * Shared by the guidance demos. A fixed clock keeps every demo deterministic for the
 * visual-regression host: ages are computed against `NOW`, never against the real time.
 */
export const NOW = '2026-10-13T12:00:00.000Z'
export const OBSERVED = '2026-10-13T11:56:00.000Z'
export const OBSERVED_EARLIER = '2026-10-13T11:41:00.000Z'

/** A promise that settles after `ms`; the pending state of a demo action. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** The line a demo shows for what the app received or did; announced politely. */
export function Outcome({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <p role="status" className="mt-3 min-h-5 text-sm text-foreground-light">
      {children}
    </p>
  )
}

/** A captioned block inside a demo (a "before and after", a state next to its sibling). */
export function Labeled({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-medium text-foreground-lighter">{label}</p>
      {children}
    </div>
  )
}
