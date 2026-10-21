import { PanelLeft } from '@exponetdb/icons'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  useIsMobile,
  usePanelRef,
  useSidebar,
} from '@exponetdb/ui'
import {
  CommandMenu,
  CommandProvider,
  ShortcutProvider,
  UntrustedName,
  useLinkComponent,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ProfileAvatar } from '../features/account/avatar.tsx'
import { displayNameOf, type ProfileMe } from '../features/account/profile-model.ts'
import { installationQuery } from '../features/settings/keys.ts'
import { targetOfPathname } from '../features/target/params.ts'
import { forgetRecentTargets, pruneRecentTargets } from '../features/target/recent-storage.ts'
import { useApi } from '../lib/api/context.tsx'
import { t } from '../lib/i18n/i18n.ts'
import {
  readSectionMenuWidth,
  rememberSectionMenuWidth,
  SECTION_MENU_MAX_WIDTH,
  SECTION_MENU_MIN_WIDTH,
} from '../lib/preferences/section-menu.ts'
import { setLetterShortcuts, useLetterShortcuts } from '../lib/preferences/shortcuts.ts'
import {
  parseSidebarMode,
  setSidebarMode,
  toggleSidebarMode,
  useSidebarMode,
} from '../lib/preferences/sidebar.ts'
import {
  parseThemePreference,
  setThemePreference,
  useThemePreference,
} from '../lib/preferences/theme.ts'
import { useMe } from '../lib/session/guard.tsx'
import { forgetSqlTabs } from '../lib/storage/sql-tabs.ts'
import { AppHeader } from './app-header.tsx'
import { ShellBreadcrumbs } from './breadcrumbs.tsx'
import { ShellCommands } from './commands.tsx'
import { shellLevel } from './levels.ts'
import { isCurrent, type NavItem, type NavSection, sectionMenu, sectionOf } from './navigation.ts'
import { AccountNav, AccountRail, FleetRail, TargetRail } from './rail.tsx'

export { isCurrent } from './navigation.ts'

/**
 * The frame of every signed-in page, built as Supabase Studio builds its
 * dashboard (information-architecture.md §2): a column exactly the screen's
 * height with the header across the top and, below it, the rail, the menu of
 * the current section where it has one, and the page in a `main` landmark
 * that alone scrolls (a skip link reaches it first). The rail lists the
 * sections of the level the page is on: the fleet, one target, or (only as the
 * phone's sheet) the account, which has its own column instead. The rail is
 * collapsed to its icons and expands over the page while the pointer rests on
 * it, stays open or stays collapsed, as the person chose; on a phone it is a
 * sheet that closes when a page in it is chosen.
 */

/** A collapsed rail item names itself only once the pointer has rested on it this long. */
const RAIL_TOOLTIP_DELAY_MS = 1000

/** On a phone the rail is a sheet; choosing a page in it closes it (any change of the address). */
function CloseSheetOnNavigation({ pathname }: { readonly pathname: string }): null {
  const { setOpenMobile } = useSidebar()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger, not an input
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile])
  return null
}

export function AppShell({ children }: { readonly children: ReactNode }): ReactNode {
  const letters = useLetterShortcuts()
  return (
    <ShortcutProvider
      strict={import.meta.env.DEV}
      characterShortcuts={letters}
      onCharacterShortcutsChange={setLetterShortcuts}
    >
      <CommandProvider>
        <ShellCommands />
        <ShellFrame>{children}</ShellFrame>
        <CommandMenu />
      </CommandProvider>
    </ShortcutProvider>
  )
}

function ShellFrame({ children }: { readonly children: ReactNode }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const mode = useSidebarMode()
  const isMobile = useIsMobile()
  const level = shellLevel(pathname)
  const target = level === 'target' ? targetOfPathname(pathname) : undefined
  const section = level === 'fleet' ? sectionOf(pathname) : undefined
  const menu = section === undefined ? [] : sectionMenu(section.id)
  const identityId = useMe().identity.id
  const pageScroller = useRef<HTMLElement>(null)
  // A recent-databases list belongs to the person who opened the databases: another person's
  // list, left by a session that ended without a sign-out, goes when this person's page opens.
  useEffect(() => pruneRecentTargets(identityId), [identityId])
  // A new page starts at its top (a change of the address only, never of its query string).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger, not an input
  useEffect(() => {
    if (pageScroller.current !== null) pageScroller.current.scrollTop = 0
    // `scrollingElement` is null (or, in some environments, undefined) without a rendered document.
    const page = document.scrollingElement as Element | null | undefined
    if (page) page.scrollTop = 0
  }, [pathname])
  // The account has its own column on wide screens; on a phone its pages are in the sheet.
  const showRail = level !== 'account' || isMobile
  // The page scrolls in its own container, so the container is in the tab order: a page with
  // nothing focusable on it (an installation's facts) is still scrolled from the keyboard
  // (axe: scrollable-region-focusable). Its focus ring is drawn inside it.
  const page = (
    <main
      ref={pageScroller}
      id="content"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must take focus
      tabIndex={0}
      className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-background outline-hidden focus-visible:ring-[length:var(--focus-ring-width)] focus-visible:ring-ring focus-visible:ring-inset"
    >
      <ShellBreadcrumbs />
      {children}
    </main>
  )
  return (
    // The frame is exactly the screen's height: the header and the rail stay where they are and
    // only the page scrolls (its own scroll container, reset on a new page).
    <SidebarProvider
      open={mode === 'open'}
      onOpenChange={toggleSidebarMode}
      tooltipDelayDuration={RAIL_TOOLTIP_DELAY_MS}
      className="h-svh flex-col overflow-hidden"
    >
      <CloseSheetOnNavigation pathname={pathname} />
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-100 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus-ring"
      >
        {t('shell.skip')}
      </a>
      <AppHeader level={level} pathname={pathname} accountMenu={<AccountMenu />} />
      <div className="flex min-h-0 w-full flex-1">
        {showRail ? (
          <Sidebar
            collapsible="icon"
            expandOnHover={mode === 'hover'}
            label={t('shell.navigation')}
            className="z-50"
          >
            <SidebarContent className="pt-1">
              {level === 'account' ? (
                <AccountRail pathname={pathname} />
              ) : target !== undefined ? (
                <TargetRail
                  target={target}
                  pathname={pathname}
                  fallback={<FleetRail pathname={pathname} current={sectionOf(pathname)} />}
                />
              ) : (
                <FleetRail pathname={pathname} current={section} />
              )}
            </SidebarContent>
            <SidebarFooter>
              <SidebarModeMenu />
            </SidebarFooter>
          </Sidebar>
        ) : (
          <AccountNav
            pathname={pathname}
            className="hidden h-full w-64 shrink-0 overflow-y-auto border-r border-default bg-dash-sidebar md:flex"
          />
        )}
        {/* Below md the section menu lives in the sheet; a panel group would still reserve its
            256 px (the panel's own inline `display: flex` beats a `hidden` class). */}
        {section !== undefined && menu.length > 0 && !isMobile ? (
          <SectionMenuFrame section={section} items={menu} pathname={pathname}>
            {page}
          </SectionMenuFrame>
        ) : (
          page
        )}
      </div>
    </SidebarProvider>
  )
}

/**
 * The section menu beside the page, as Studio's product menu: a column with
 * the section's name in a header as tall as the frame's and its pages below,
 * scrolling on its own, in a resizable panel. Its width is read when the panel
 * appears and then left alone (the library takes `defaultSize` as the starting
 * size); the width a person drags it to is kept per browser, and layouts the
 * library sets itself (on mount, on a change of the window) are not a choice
 * and are not kept.
 */
function SectionMenuFrame({
  section,
  items,
  pathname,
  children,
}: {
  readonly section: NavSection
  readonly items: readonly NavItem[]
  readonly pathname: string
  readonly children: ReactNode
}): ReactNode {
  const panel = usePanelRef()
  const [width] = useState(readSectionMenuWidth)
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 min-w-0 flex-1"
      onLayoutChanged={(_layout, meta) => {
        const pixels = panel.current?.getSize().inPixels
        if (meta.isUserInteraction && pixels !== undefined) rememberSectionMenuWidth(pixels)
      }}
    >
      <ResizablePanel
        id="section-menu"
        panelRef={panel}
        defaultSize={width}
        minSize={SECTION_MENU_MIN_WIDTH}
        maxSize={SECTION_MENU_MAX_WIDTH}
        groupResizeBehavior="preserve-pixel-size"
        className="hidden md:block"
      >
        <SectionMenu section={section} items={items} pathname={pathname} />
      </ResizablePanel>
      <ResizableHandle className="hidden md:flex" aria-label={t('shell.sectionMenu.resize')} />
      <ResizablePanel id="page" className="flex min-w-0">
        {children}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/** The pages of the current section beside the page (wide screens). */
function SectionMenu({
  section,
  items,
  pathname,
}: {
  readonly section: NavSection
  readonly items: readonly NavItem[]
  readonly pathname: string
}): ReactNode {
  const Link = useLinkComponent()
  // The page whose path is the longest match is the current one (`/changes` and `/changes/plans`).
  const current = items
    .filter((item) => isCurrent(item.path, pathname))
    .sort((a, b) => b.path.length - a.path.length)[0]
  return (
    <nav
      aria-label={t('shell.sectionMenu', { section: section.label })}
      className="flex h-full flex-col border-r border-default bg-dash-sidebar"
    >
      <div className="flex h-12 shrink-0 items-center border-b border-default px-6">
        <p className="truncate text-sm font-medium text-foreground">{section.label}</p>
      </div>
      <ul className="flex grow flex-col gap-px overflow-y-auto px-3 py-4">
        {items.map((item) => {
          const active = current?.id === item.id
          return (
            <li key={item.id}>
              <Link
                href={item.path}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex rounded-md px-3 py-[3px] text-sm transition-colors focus-ring',
                  active
                    ? 'bg-sidebar-accent font-semibold text-foreground'
                    : 'text-foreground-light hover:bg-sidebar-accent/50 hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function SidebarModeMenu(): ReactNode {
  const mode = useSidebarMode()
  const { isMobile } = useSidebar()
  // The sheet of small screens has no modes.
  if (isMobile) return null
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton tooltip={t('shell.sidebar')}>
              <PanelLeft aria-hidden="true" />
              <span>{t('shell.sidebar')}</span>
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end">
            <DropdownMenuLabel>{t('shell.sidebar')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={mode}
              onValueChange={(value) => setSidebarMode(parseSidebarMode(value))}
            >
              <DropdownMenuRadioItem value="hover">
                {t('shell.sidebar.hover')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="open">{t('shell.sidebar.open')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="collapsed">
                {t('shell.sidebar.collapsed')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function AccountMenu(): ReactNode {
  const me = useMe() as ProfileMe
  const { client } = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const theme = useThemePreference()
  // The name and the address are text a person typed: shown through the untrusted-name pattern (C-26).
  const name = displayNameOf(me)
  const email = me.identity.email
  const signOut = (): void => {
    void client
      .ceremony('/auth/logout')
      .catch(() => undefined)
      .finally(() => {
        // Signed out, or the session had already ended: nothing of it stays in memory,
        // and no SQL tab text of it stays in this browser.
        queryClient.clear()
        forgetSqlTabs()
        forgetRecentTargets()
        window.location.assign('/login')
      })
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          id="account-menu"
          aria-label={t('shell.account')}
          className="rounded-full focus-ring"
        >
          <ProfileAvatar avatar={me.avatar} name={name} size="sm" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-3 font-normal">
          <ProfileAvatar avatar={me.avatar} name={name} />
          <span className="flex min-w-0 flex-col">
            <UntrustedName
              name={name}
              maxCodePoints={40}
              label={t('account.name')}
              className="text-sm font-medium text-foreground"
            />
            {email === null || email === name ? null : (
              <UntrustedName
                name={email}
                maxCodePoints={40}
                label={t('account.email')}
                className="text-xs text-foreground-lighter"
              />
            )}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/account')}>
          {t('shell.account.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/account/preferences')}>
          {t('accountMenu.preferences')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/account/security')}>
          {t('accountMenu.security')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/account/applications')}>
          {t('accountMenu.applications')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/account/activity')}>
          {t('accountMenu.activity')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('accountMenu.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) =>
            setThemePreference(parseThemePreference(value), document.documentElement)
          }
        >
          <DropdownMenuRadioItem value="light">{t('shell.theme.light')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t('shell.theme.dark')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t('shell.theme.system')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem id="sign-out" onSelect={signOut}>
          {t('shell.signOut')}
        </DropdownMenuItem>
        <AccountVersion />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The version of the app at the foot of the account menu, from the installation read made
 * when the menu opens. It shows only while that read holds: a read that failed or has not
 * arrived shows nothing here (Settings, Installation says what is wrong with it).
 */
function AccountVersion(): ReactNode {
  const { client } = useApi()
  const installation = useQuery(installationQuery(client))
  if (!installation.isSuccess) return null
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel
        data-slot="app-version"
        className="text-xs font-normal text-foreground-lighter"
      >
        {t('shell.account.version', { version: installation.data.version })}
      </DropdownMenuLabel>
    </>
  )
}
