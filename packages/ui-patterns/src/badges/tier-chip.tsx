import { Server } from '@exponetdb/icons'
import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'

import { UntrustedName } from '../untrusted/untrusted-name.tsx'

/** A tier or environment name. `production` and `prod` are the production tier; every other name is not. */
export type TierName = 'production' | 'staging' | 'development' | (string & Record<never, never>)

/** The one test for production in the UI: the exact tier names `production` and `prod`. */
export function isProductionTier(tier: string): boolean {
  return tier === 'production' || tier === 'prod'
}

const KNOWN_LABELS: Readonly<Record<string, string>> = {
  production: 'Production',
  prod: 'Production',
  staging: 'Staging',
  development: 'Development',
  nonprod: 'Non-production',
}

export interface TierChipProps {
  /** `production` or `prod` for the production tier; any other name is shown as a neutral chip. */
  tier: TierName
  className?: string
}

/**
 * The tier of an environment, as a chip. Production uses the reserved
 * `production` color, a server icon and the word "Production", so it is
 * recognizable everywhere and never confused with an error; every other tier is
 * neutral. The color is never the only signal: the word is always there.
 */
export function TierChip({ tier, className }: TierChipProps): ReactNode {
  const production = isProductionTier(tier)
  const known = KNOWN_LABELS[tier]
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
      {known ?? <UntrustedName name={tier} maxCodePoints={32} label="environment name" />}
    </span>
  )
}
