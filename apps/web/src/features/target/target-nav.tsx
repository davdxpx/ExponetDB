import { PageNav, type PageNavItem } from '@exponetdb/ui-patterns'
import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { TARGET_NAV, targetHref } from '../../shell/navigation.ts'
import type { TargetRoute } from './params.ts'

/**
 * The target's sections as a named navigation (information-architecture.md
 * section 2.2): every section of `TARGET_NAV` is listed, the pages that wait
 * for Wave 9 included (they open on a named "not available yet" state). The
 * overview is current only on the exact target path; any other section is
 * current on its page and the pages below it. Links are built from the
 * validated slugs and the fixed suffixes of the list.
 */
export function targetNavItems(target: TargetRoute, pathname: string): readonly PageNavItem[] {
  const base = targetHref(target)
  return TARGET_NAV.map((item) => {
    const href = targetHref(target, item.suffix)
    const active =
      item.suffix === ''
        ? pathname === base || pathname === `${base}/`
        : pathname === href || pathname.startsWith(`${href}/`)
    return { label: item.label, href, active }
  })
}

export function TargetNav({ target }: { readonly target: TargetRoute }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return <PageNav label={t('target.nav.label')} items={targetNavItems(target, pathname)} />
}
