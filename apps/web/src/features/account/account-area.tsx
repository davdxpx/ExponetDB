import {
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from '@exponetdb/ui-patterns'
import { Outlet } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { isRecoverySession } from './account-model.ts'
import { SecurityPage } from './security-page.tsx'

/**
 * The account area (`/account` and its pages, inside the shell), modelled on
 * Studio's account pages: the shell gives it a column of its own instead of
 * the rail ("Back to the fleet", its settings and its activity, from
 * `ACCOUNT_TABS`; in the phone's sheet the same list) and the page renders in
 * the `Outlet`. The pages are fixed app paths. A recovery session may only
 * replace its factors: it gets the security page on every path of the area.
 */
export const ACCOUNT_TABS = [
  { id: 'profile', path: '/account', label: () => t('accountArea.profile') },
  { id: 'preferences', path: '/account/preferences', label: () => t('accountMenu.preferences') },
  { id: 'security', path: '/account/security', label: () => t('accountMenu.security') },
  {
    id: 'applications',
    path: '/account/applications',
    label: () => t('accountMenu.applications'),
  },
  { id: 'activity', path: '/account/activity', label: () => t('accountMenu.activity') },
] as const

export function AccountArea(): ReactNode {
  const me = useMe()
  const recovery = isRecoverySession(me)
  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('account.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('account.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small" className="py-6">
        {recovery ? <SecurityPage /> : <Outlet />}
      </PageContainer>
    </>
  )
}
