import { cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { FleetBackupHealth } from '../wave9/fleet-backup-health.tsx'

/**
 * The overview's place for backup health: `FleetBackupHealth` from Wave 9 (handoff in
 * PRE-WAVE-11-REVIEW.md, U9) reads its own data and renders its own Readable states, so the
 * overview never claims that backups are safe: unknown is not safe.
 */
export function ProtectionSlot({ className }: { readonly className?: string }): ReactNode {
  return (
    <section
      aria-labelledby="fleet-protection"
      data-slot="fleet-backups"
      className={cn('flex min-w-0 flex-col gap-3', className)}
    >
      <h2 id="fleet-protection" className="m-0 text-base font-medium">
        {t('fleet.protection.title')}
      </h2>
      <FleetBackupHealth />
    </section>
  )
}
