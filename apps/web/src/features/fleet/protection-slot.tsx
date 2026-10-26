import { DatabaseBackup } from '@exponetdb/icons'
import { Card, cn } from '@exponetdb/ui'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'

/**
 * The overview's place for backup health. Until Wave 9 serves backup reads it is a short named
 * state, "not observed yet", in its own small card, so the overview never claims that backups
 * are safe: unknown is not safe.
 *
 * Wave 9 integration (handoff in PRE-WAVE-11-REVIEW.md, UI/UX section): Wave 9 provides
 * `features/wave9/fleet-backup-health.tsx` exporting `FleetBackupHealth` (a component that reads
 * its own data and renders its own Readable states); the one change here is to render it in
 * place of `<NotObservedYet />`. Nothing else of the overview or the shell changes.
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
      <NotObservedYet />
    </section>
  )
}

function NotObservedYet(): ReactNode {
  return (
    <Card className="flex items-start gap-3 p-4" data-state="not-available-yet">
      <DatabaseBackup
        aria-hidden="true"
        strokeWidth={1.5}
        className="mt-0.5 size-5 shrink-0 text-foreground-lighter"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="m-0 text-sm font-medium">{t('fleet.protection.state')}</p>
        <p className="m-0 text-xs text-foreground-light">{t('fleet.backups.reason')}</p>
      </div>
    </Card>
  )
}
