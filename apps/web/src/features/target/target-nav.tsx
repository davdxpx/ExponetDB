import type { Readable } from '@exponetdb/ui-patterns'
import { TARGET_NAV, type TargetNavItem, targetHref } from '../../shell/navigation.ts'
import type { TargetRoute } from './params.ts'
import type { Target } from './queries.ts'

/**
 * The number of open findings to show on the Findings section, or `undefined` for
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

/** A section of the target's rail, with its link and whether the page is in it. */
export interface TargetNavEntry {
  readonly section: TargetNavItem
  readonly label: string
  readonly href: string
  readonly active: boolean
  /** The open findings, on the Findings section only and only when there is a count to show. */
  readonly count?: number
}

/**
 * The target's sections (information-architecture.md section 2.2), as the
 * target's rail lists them: every section of `TARGET_NAV`, the pages that wait
 * for Wave 9 included (they open on a named "not available yet" state). The
 * overview is current only on the exact target path; any other section is
 * current on its page and the pages below it. Links are built from the
 * validated slugs and the fixed suffixes of the list. The Findings section
 * carries the count of open findings when `findings` holds one.
 */
export function targetNavItems(
  target: TargetRoute,
  pathname: string,
  findings?: number,
): readonly TargetNavEntry[] {
  const base = targetHref(target)
  return TARGET_NAV.map((section) => {
    const href = targetHref(target, section.suffix)
    const active =
      section.suffix === ''
        ? pathname === base || pathname === `${base}/`
        : pathname === href || pathname.startsWith(`${href}/`)
    return {
      section,
      label: section.label,
      href,
      active,
      ...(section.id === 'findings' && findings !== undefined ? { count: findings } : {}),
    }
  })
}
