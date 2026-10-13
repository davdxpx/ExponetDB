import { NotAvailableYetState } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { SettingsFrame } from './settings-frame.tsx'

/**
 * `/settings/notifications`: the notification channels wait for the owner
 * decision on the delivery channel (OD-21, order D7). The page exists and says
 * so; it shows no channel, no form and no empty list.
 */
export function NotificationsPage(): ReactNode {
  return (
    <SettingsFrame
      title={t('settings.notifications.title')}
      description={t('settings.notifications.description')}
    >
      <NotAvailableYetState
        what={t('settings.notifications.what')}
        reason={t('target.state.od21.reason')}
        headingLevel={2}
      />
      <p className="text-sm text-foreground-light">{t('settings.notifications.consequences')}</p>
    </SettingsFrame>
  )
}
