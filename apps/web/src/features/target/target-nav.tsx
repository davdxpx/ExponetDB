import { PageNav, type PageNavItem, type Readable } from '@exponetdb/ui-patterns'
import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { t } from '../../lib/i18n/i18n.ts'
import { TARGET_NAV, targetHref } from '../../shell/navigation.ts'
import type { TargetRoute } from './params.ts'
import { type Target, useTarget } from './queries.ts'

/** Past this many the tab says "99+" (the sentence for assistive technology still has the number). */
const BADGE_CAP = 99

/**
 * The number of open findings to show on the Findings tab, or `undefined` for
 * "show nothing". It is a count only when the target read succeeded (`ready`
 * or `partial`): a read that failed, is loading or is only an earlier read
 * says nothing, and a count that could not be read is never shown as 0. A
 * count of 0 shows nothing either; the Findings page says "no open finding"
 * after its own successful read.
 */
export function openFindingCount(read: Readable<Target>): number | undefined {
  if (read.state !== 'ready' && read.state !== 'partial') return undefined
  const count = read.value.openFindingCount
  return Number.isInteger(count) && count > 0 ? count : undefined
}

/** The badge of the Findings tab: the number, and the words for assistive technology. */
function FindingsBadge({ count }: { readonly count: number }): ReactNode {
  return (
    <span
      data-slot="findings-badge"
      className="inline-flex min-w-5 items-center justify-center rounded-full border border-strong bg-surface-300 px-1.5 text-xs leading-4 text-foreground"
    >
      <span aria-hidden="true">{count > BADGE_CAP ? `${BADGE_CAP}+` : count}</span>
      <span className="sr-only">{t('target.nav.findingsOpen', { count })}</span>
    </span>
  )
}

/**
 * The target's sections as a named navigation (information-architecture.md
 * section 2.2): every section of `TARGET_NAV` is listed, the pages that wait
 * for Wave 9 included (they open on a named "not available yet" state). The
 * overview is current only on the exact target path; any other section is
 * current on its page and the pages below it. Links are built from the
 * validated slugs and the fixed suffixes of the list. The Findings tab
 * carries the count of open findings when `findings` holds one.
 */
export function targetNavItems(
  target: TargetRoute,
  pathname: string,
  findings?: number,
): readonly PageNavItem[] {
  const base = targetHref(target)
  return TARGET_NAV.map((item) => {
    const href = targetHref(target, item.suffix)
    const active =
      item.suffix === ''
        ? pathname === base || pathname === `${base}/`
        : pathname === href || pathname.startsWith(`${href}/`)
    return {
      label: item.label,
      href,
      active,
      ...(item.id === 'findings' && findings !== undefined
        ? { badge: <FindingsBadge count={findings} /> }
        : {}),
    }
  })
}

export function TargetNav({ target }: { readonly target: TargetRoute }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // The same read the layout and the context bar make (one query, one request).
  const read = useTarget(target.path)
  return (
    <PageNav
      label={t('target.nav.label')}
      items={targetNavItems(target, pathname, openFindingCount(read.readable))}
    />
  )
}
