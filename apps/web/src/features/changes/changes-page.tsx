import { Card, CardContent } from '@exponetdb/ui'
import {
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { OPERATIONS_PATH, operationsInState, PROMOTION_PATH } from './model.ts'

interface Entry {
  readonly title: MessageKey
  readonly body: MessageKey
  readonly links: readonly { readonly href: string; readonly label: MessageKey }[]
}

const ENTRIES: readonly Entry[] = [
  {
    title: 'changes.landing.plans.title',
    body: 'changes.landing.plans.body',
    links: [
      { href: '/changes/plans', label: 'changes.landing.plans.link' },
      { href: '/approvals', label: 'changes.landing.approvals.link' },
    ],
  },
  {
    title: 'changes.landing.operations.title',
    body: 'changes.landing.operations.body',
    links: [
      { href: OPERATIONS_PATH, label: 'changes.landing.operations.link' },
      { href: operationsInState('running'), label: 'changes.landing.operations.running' },
      {
        href: operationsInState('needs_attention'),
        label: 'changes.landing.operations.attention',
      },
      { href: operationsInState('failed'), label: 'changes.landing.operations.failed' },
    ],
  },
  {
    title: 'changes.landing.promotion.title',
    body: 'changes.landing.promotion.body',
    links: [{ href: PROMOTION_PATH, label: 'changes.landing.promotion.link' }],
  },
]

/**
 * All changes (`/changes`): where plans, operations and the promotion view
 * of each project live. The page reads nothing itself; each linked page
 * reads its own list with its own states.
 */
export function ChangesPage(): ReactNode {
  const Link = useLinkComponent()
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{t('changes.landing.title')}</PageHeaderTitle>
            <PageHeaderDescription>{t('changes.landing.description')}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large" className="py-6">
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {ENTRIES.map((entry) => (
            <li key={entry.title}>
              <Card className="h-full">
                <CardContent className="flex h-full flex-col gap-2 p-card">
                  <h2 className="text-base font-medium">{t(entry.title)}</h2>
                  <p className="text-sm text-foreground-light">{t(entry.body)}</p>
                  <ul className="mt-auto flex flex-col gap-1 text-sm">
                    {entry.links.map((link) => (
                      <li key={link.href}>
                        <Link href={link.href} className="text-primary underline focus-ring">
                          {t(link.label)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      </PageContainer>
    </>
  )
}
