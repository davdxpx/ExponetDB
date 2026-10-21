import { ArrowLeft } from '@exponetdb/icons'
import {
  cn,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from '@exponetdb/ui'
import { ShortcutKeys, useActiveShortcuts, useLinkComponent } from '@exponetdb/ui-patterns'
import { Fragment, type ReactNode } from 'react'
import { ACCOUNT_TABS } from '../features/account/account-area.tsx'
import { isRecoverySession } from '../features/account/account-model.ts'
import type { TargetRoute } from '../features/target/params.ts'
import { useTarget } from '../features/target/queries.ts'
import { openFindingCount, targetNavItems } from '../features/target/target-nav.tsx'
import { t } from '../lib/i18n/i18n.ts'
import { useLetterShortcuts } from '../lib/preferences/shortcuts.ts'
import { useMe } from '../lib/session/guard.tsx'
import { isCurrent, NAV_SECTIONS, type NavSection, sectionMenu } from './navigation.ts'

/**
 * What the rail lists, by level (information-architecture.md §2): the fleet's
 * sections, or one target's sections grouped as Studio groups a project's
 * rail, or (on a phone, where the account has no column) the account's pages.
 * A separator divides the groups. On a phone the rail is a sheet and also
 * lists the pages of each fleet section under it.
 */

/** `page` on the page itself, `true` on a section the page belongs to, else nothing. */
function currentness(
  path: string,
  pathname: string,
  inSection: boolean,
): 'page' | 'true' | undefined {
  if (pathname === path) return 'page'
  return inSection ? 'true' : undefined
}

function RailGroups<T>({
  groups,
  render,
}: {
  readonly groups: readonly (readonly T[])[]
  readonly render: (item: T) => ReactNode
}): ReactNode {
  return groups
    .filter((group) => group.length > 0)
    .map((group, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the groups are a fixed order
      <Fragment key={index}>
        {index === 0 ? null : <SidebarSeparator className="mx-auto w-[calc(100%-1rem)]" />}
        <SidebarGroup className="gap-0.5">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">{group.map(render)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </Fragment>
    ))
}

/** The fleet's sections (`NAV_SECTIONS`), in their four blocks. */
export function FleetRail({
  pathname,
  current,
}: {
  readonly pathname: string
  readonly current: NavSection | undefined
}): ReactNode {
  const blocks = ([1, 2, 3, 4] as const).map((block) =>
    NAV_SECTIONS.filter((item) => item.block === block),
  )
  return (
    <nav aria-label={t('shell.navigation')}>
      <RailGroups
        groups={blocks}
        render={(item) => (
          <FleetRailItem
            key={item.id}
            section={item}
            pathname={pathname}
            current={current?.id === item.id}
          />
        )}
      />
    </nav>
  )
}

function FleetRailItem({
  section,
  pathname,
  current,
}: {
  readonly section: NavSection
  readonly pathname: string
  readonly current: boolean
}): ReactNode {
  const Link = useLinkComponent()
  const { isMobile } = useSidebar()
  const letters = useLetterShortcuts()
  const active = useActiveShortcuts()
  // On a phone the rail is a sheet: the section pages are listed under their section.
  const pages = isMobile ? sectionMenu(section.id) : []
  // The keys go in the tooltip only while they work: the letter shortcuts are on and the
  // shortcut has a handler on this page (the registry knows the keys and the platform).
  const hint = letters && active.includes(section.shortcut)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={current}
        tooltip={
          hint
            ? {
                children: (
                  <span className="flex items-center gap-3">
                    <span>{section.label}</span>
                    <ShortcutKeys shortcut={section.shortcut} />
                  </span>
                ),
              }
            : section.label
        }
      >
        <Link href={section.path} aria-current={currentness(section.path, pathname, current)}>
          <section.icon aria-hidden="true" strokeWidth={1.5} />
          <span>{section.label}</span>
        </Link>
      </SidebarMenuButton>
      {pages.length > 0 ? (
        <SidebarMenuSub>
          {pages.map((page) => (
            <SidebarMenuSubItem key={page.id}>
              <SidebarMenuSubButton asChild isActive={isCurrent(page.path, pathname)}>
                <Link href={page.path} aria-current={pathname === page.path ? 'page' : undefined}>
                  <span>{page.label}</span>
                </Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          ))}
        </SidebarMenuSub>
      ) : null}
    </SidebarMenuItem>
  )
}

/** Past this many the badge says "99+" (the words for assistive technology keep the number). */
const BADGE_CAP = 99

/**
 * One target's sections (`TARGET_NAV`) in their groups, as links built from
 * the validated slugs. The Findings item carries the count of open findings
 * when the target read succeeded (never a count that could not be read): the
 * number beside the label, and the words in the link's name. For a target
 * the server does not know (or hides) the page is "page not found" and the
 * rail shows no sign of it: `fallback` (the fleet's rail) instead.
 */
export function TargetRail({
  target,
  pathname,
  fallback = null,
}: {
  readonly target: TargetRoute
  readonly pathname: string
  readonly fallback?: ReactNode
}): ReactNode {
  const Link = useLinkComponent()
  // The same read the layout and the header make (one query, one request).
  const read = useTarget(target.path)
  if (read.notFound) return fallback
  const items = targetNavItems(target, pathname, openFindingCount(read.readable))
  const groups = ([1, 2, 3, 4] as const).map((group) =>
    items.filter((item) => item.section.group === group),
  )
  return (
    <nav aria-label={t('target.nav.label')}>
      <RailGroups
        groups={groups}
        render={(item) => (
          <SidebarMenuItem key={item.href}>
            <SidebarMenuButton asChild isActive={item.active} tooltip={item.label}>
              <Link href={item.href} aria-current={item.active ? 'page' : undefined}>
                <item.section.icon aria-hidden="true" strokeWidth={1.5} />
                <span>
                  {item.label}
                  {item.count === undefined ? null : (
                    <>
                      {' '}
                      <span className="sr-only">
                        {t('target.nav.findingsOpen', { count: item.count })}
                      </span>
                    </>
                  )}
                </span>
              </Link>
            </SidebarMenuButton>
            {item.count === undefined ? null : (
              <SidebarMenuBadge data-slot="findings-badge" aria-hidden="true">
                {item.count > BADGE_CAP ? `${BADGE_CAP}+` : item.count}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        )}
      />
    </nav>
  )
}

/** The account's pages, for the phone's sheet (wide screens have the account column). */
export function AccountRail({ pathname }: { readonly pathname: string }): ReactNode {
  return <AccountNav pathname={pathname} />
}

/**
 * The account's pages as Studio's account column lists them: "Back to the
 * fleet", then the settings and the activity, the current one marked. A
 * recovery session may only replace its factors (every path of the area shows
 * the security page), so it lists nothing.
 */
export function AccountNav({
  pathname,
  className,
}: {
  readonly pathname: string
  readonly className?: string
}): ReactNode {
  const Link = useLinkComponent()
  const recovery = isRecoverySession(useMe())
  if (recovery) return null
  const settings = ACCOUNT_TABS.filter((tab) => tab.id !== 'activity')
  const logs = ACCOUNT_TABS.filter((tab) => tab.id === 'activity')
  const item = (tab: (typeof ACCOUNT_TABS)[number]): ReactNode => {
    const active = pathname === tab.path
    return (
      <li key={tab.id}>
        <Link
          href={tab.path}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex rounded-md px-3 py-[3px] text-sm transition-colors focus-ring',
            active
              ? 'bg-sidebar-accent font-semibold text-foreground'
              : 'text-foreground-light hover:bg-sidebar-accent/50 hover:text-foreground',
          )}
        >
          {tab.label()}
        </Link>
      </li>
    )
  }
  return (
    <nav aria-label={t('accountArea.nav')} className={cn('flex flex-col', className)}>
      <div className="flex h-12 shrink-0 items-center border-b border-default px-6">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm text-foreground-light hover:text-foreground focus-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" strokeWidth={1.5} />
          {t('shell.account.back')}
        </Link>
      </div>
      <div className="flex flex-col gap-4 px-3 py-4">
        <div className="flex flex-col gap-1">
          <p className="px-3 font-mono text-xs tracking-wider text-foreground-lighter uppercase">
            {t('shell.account.settings')}
          </p>
          <ul className="flex flex-col">{settings.map(item)}</ul>
        </div>
        <div className="flex flex-col gap-1 border-t border-default pt-4">
          <p className="px-3 font-mono text-xs tracking-wider text-foreground-lighter uppercase">
            {t('shell.account.logs')}
          </p>
          <ul className="flex flex-col">{logs.map(item)}</ul>
        </div>
      </div>
    </nav>
  )
}
