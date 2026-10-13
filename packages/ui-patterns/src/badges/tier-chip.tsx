import { Server } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { UntrustedName } from '../untrusted/untrusted-name.tsx'

/** The authorization tier of the contracts (C-24): `prod` or `nonprod`. */
export type TierName = 'prod' | 'nonprod' | (string & Record<never, never>)

/**
 * The one test for production in the UI, on the contract's tier. It fails
 * closed: anything that is not exactly `nonprod` (a missing value, a new tier,
 * a misspelling) is treated as production.
 */
export function isProductionTier(tier: string | null | undefined): boolean {
  return tier !== 'nonprod'
}

export interface TierChipProps {
  /** The contract's tier (`TargetView.tier`, `environment.tier`, `PlanView.subject.tier`). */
  tier: TierName
  /**
   * The environment's name (its slug), shown in the chip. It never decides the tier: an
   * environment named `prod` with tier `nonprod` is not production, and one named `live`
   * with tier `prod` is. Without a name the chip names the tier.
   */
  name?: string
  className?: string
}

/**
 * The tier of an environment, as a chip. Production uses the reserved
 * `production` color, a server icon and the word "Production", so it is
 * recognizable everywhere and never confused with an error; every other tier is
 * neutral. The color is never the only signal: the word is always there.
 */
export function TierChip({ tier, name, className }: TierChipProps): ReactNode {
  const production = isProductionTier(tier)
  // The name repeats nothing: `production` in a production chip is said once.
  const showName = name !== undefined && !(production && (name === 'production' || name === 'prod'))
  return (
    <span
      data-tier={production ? 'production' : 'nonprod'}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        production
          ? 'border-production bg-production text-production-foreground'
          : 'border-strong bg-surface-75 text-foreground-light',
        className,
      )}
    >
      {production && <Server aria-hidden="true" className="size-3" />}
      {showName ? <UntrustedName name={name} maxCodePoints={32} label="environment name" /> : null}
      {production ? (
        <span className={cn(showName && 'border-l border-current/40 pl-1')}>Production</span>
      ) : showName ? null : (
        <span>Non-production</span>
      )}
    </span>
  )
}
