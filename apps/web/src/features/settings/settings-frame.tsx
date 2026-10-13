import {
  Admonition,
  PageContainer,
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
  useLinkComponent,
} from '@exponetdb/ui-patterns'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api/context.tsx'
import { describeError, t } from '../../lib/i18n/i18n.ts'
import { classifyFailure } from '../../lib/query/errors.ts'
import { useMe } from '../../lib/session/guard.tsx'
import { holds } from '../access/fields.tsx'
import { breakGlassQuery } from './keys.ts'

/**
 * The frame of every settings page: its title and description, then the
 * break-glass banner for owners and admins when grants wait for their
 * post-incident review (resources.md: `GET /break-glass-grants?review=open`),
 * then the page. The banner reads only for a session that may read grants
 * (`policy.manage`); a failed read says so in one line and is never shown as
 * "nothing to review".
 */
export function SettingsFrame({
  title,
  description,
  children,
}: {
  readonly title: string
  readonly description: string
  readonly children: ReactNode
}): ReactNode {
  const me = useMe()
  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{title}</PageHeaderTitle>
            <PageHeaderDescription>{description}</PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer>
        {holds(me, 'policy.manage') ? <BreakGlassBanner /> : null}
        <div className="flex flex-col gap-6 pt-6 pb-12">{children}</div>
      </PageContainer>
    </>
  )
}

export function BreakGlassBanner(): ReactNode {
  const { client } = useApi()
  const Link = useLinkComponent()
  const open = useQuery({ ...breakGlassQuery(client, 'open'), refetchInterval: 60_000 })
  if (open.data === undefined) {
    if (!open.isError || classifyFailure(open.error).kind === 'not_permitted') return null
    return (
      <p id="break-glass-banner" data-state="failed" className="pt-6 text-sm text-foreground-light">
        {t('settings.breakGlass.banner.failed', { reason: describeError(open.error) })}
      </p>
    )
  }
  const reviewable = open.data.items.filter((grant) => grant.state !== 'active').length
  const active = open.data.items.length - reviewable
  if (reviewable === 0 && active === 0) return null
  const more = open.data.nextCursor !== null
  return (
    <div id="break-glass-banner" data-state="open" className="pt-6">
      <Admonition
        type="warning"
        title={
          reviewable === 0
            ? t('settings.breakGlass.banner.activeOnly', { count: active })
            : t(
                more ? 'settings.breakGlass.banner.titleMore' : 'settings.breakGlass.banner.title',
                {
                  count: reviewable,
                },
              )
        }
        description={
          reviewable > 0 && active > 0
            ? t('settings.breakGlass.banner.alsoActive', { count: active })
            : t('settings.breakGlass.banner.body')
        }
        actions={
          <Link href="/settings/break-glass" className="text-foreground underline">
            {t('settings.breakGlass.banner.link')}
          </Link>
        }
      />
    </div>
  )
}
