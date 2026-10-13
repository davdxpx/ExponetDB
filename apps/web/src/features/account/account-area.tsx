import { cn } from '@exponetdb/ui'
import {
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { Outlet, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { isRecoverySession } from './account-model.ts'
import { SecurityPage } from './security-page.tsx'

/**
 * The account area (`/account` and its tabs, inside the shell), modelled on
 * Studio's account pages: a short navigation of tabs beside the page (above
 * it on small screens) and the tab in the `Outlet`. The tabs are fixed app
 * paths. A recovery session may only replace its factors, so it gets no
 * navigation and the security tab on every path of the area.
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
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const Link = useLinkComponent()
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
      <PageContainer size="small" className="flex flex-col gap-6 py-6 md:flex-row md:gap-10">
        {recovery ? null : (
          <nav aria-label={t('accountArea.nav')} className="md:w-48 md:shrink-0">
            <ul className="flex flex-row flex-wrap gap-1 md:flex-col">
              {ACCOUNT_TABS.map((tab) => {
                const active = pathname === tab.path
                return (
                  <li key={tab.id}>
                    <Link
                      href={tab.path}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex rounded-md px-2 py-1.5 text-sm focus-ring',
                        active
                          ? 'bg-selection font-medium text-foreground'
                          : 'text-foreground-light hover:bg-surface-200 hover:text-foreground',
                      )}
                    >
                      {tab.label()}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
        )}
        <div className="min-w-0 flex-1">{recovery ? <SecurityPage /> : <Outlet />}</div>
      </PageContainer>
    </>
  )
}
