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
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useIsMobile,
  usePanelRef,
  useSidebar,
} from '@exponetdb/ui'
import {
  CommandMenu,
  CommandMenuTriggerInput,
  CommandProvider,
  ShortcutKeys,
  ShortcutProvider,
  UntrustedName,
  useActiveShortcuts,
  useLinkComponent,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Fragment, type ReactNode, type RefObject, useEffect, useRef, useState } from 'react'
import { ProfileAvatar } from '../features/account/avatar.tsx'
import { displayNameOf, type ProfileMe } from '../features/account/profile-model.ts'
import { installationQuery } from '../features/settings/keys.ts'
import { TargetContextBar } from '../features/target/context-bar.tsx'
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
import { ShellBreadcrumbs } from './breadcrumbs.tsx'
import { ShellCommands } from './commands.tsx'
import {
  isCurrent,
  NAV_SECTIONS,
  type NavItem,
  type NavSection,
  sectionMenu,
  sectionOf,
} from './navigation.ts'

export { isCurrent } from './navigation.ts'

/**
 * The frame of every signed-in page (order §7, information-architecture.md
 * §2): the icon rail of the global sections (from the IA data, one list feeds
 * the rail, the command menu and the shortcut sheet; a tooltip names each
 * icon while the rail is collapsed), the section menu of the current section
 * beside the page, a header with the command-menu field and the theme and
 * account menus, and the page in a `main` landmark that a skip link reaches
 * first. The rail expands on hover, stays open or stays collapsed, as the
 * person chose; small screens get it as a sheet with the section pages
 * listed under each section.
 */
const BLOCKS = [1, 2, 3, 4] as const

/** A collapsed rail item names itself only once the pointer has rested on it this long. */
const RAIL_TOOLTIP_DELAY_MS = 1000

/** On a phone the rail is a sheet; choosing a page in it closes it (any change of the address). */
function CloseSheetOnNavigation({ pathname }: { readonly pathname: string }): null {
  const { setOpenMobile } = useSidebar()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the path is the trigger, not an input
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile])
  return null
}

/** `page` on the page itself, `true` on a section the page belongs to, else nothing. */
function currentness(
  path: string,
  pathname: string,
  inSection: boolean,
): 'page' | 'true' | undefined {
  if (pathname === path) return 'page'
  return inSection ? 'true' : undefined
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
  const Link = useLinkComponent()
  const isMobile = useIsMobile()
  const section = sectionOf(pathname)
  const menu = section === undefined ? [] : sectionMenu(section.id)
  const identityId = useMe().identity.id
  const pageScroller = useRef<HTMLDivElement>(null)
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
  return (
    // The frame is exactly the screen's height: the rail and the header stay where they are and only
    // the page below the header scrolls (its own scroll container, reset on a new page).
    <SidebarProvider
      open={mode === 'open'}
      onOpenChange={toggleSidebarMode}
      tooltipDelayDuration={RAIL_TOOLTIP_DELAY_MS}
      className="h-svh overflow-hidden"
    >
      <CloseSheetOnNavigation pathname={pathname} />
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-100 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus-ring"
      >
        {t('shell.skip')}
      </a>
      <Sidebar collapsible="icon" expandOnHover={mode === 'hover'} label={t('shell.navigation')}>
        <SidebarHeader>
          <Link
            href="/"
            className="truncate rounded-md px-2 py-1 text-base font-semibold text-foreground focus-ring"
          >
            {t('app.name')}
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label={t('shell.navigation')}>
            {BLOCKS.map((block) => (
              <Fragment key={block}>
                {block === 1 ? null : <SidebarSeparator />}
                <SidebarGroup>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {NAV_SECTIONS.filter((item) => item.block === block).map((item) => (
                        <RailItem
                          key={item.id}
                          section={item}
                          pathname={pathname}
                          current={section?.id === item.id}
                        />
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              </Fragment>
            ))}
          </nav>
        </SidebarContent>
        <SidebarFooter>
          <SidebarModeMenu />
        </SidebarFooter>
      </Sidebar>
      {/* SidebarInset is the page's `main` landmark, the target of the skip link. */}
      <SidebarInset id="content" tabIndex={-1} className="min-h-0 min-w-0 outline-none">
        <header className="flex h-12 min-w-0 shrink-0 items-center gap-2 border-b border-default px-3">
          <SidebarTrigger />
          {/* On target pages: Product / Project / Environment, with the tier chip (IA §3). */}
          <TargetContextBar />
          <CommandMenuTriggerInput placeholder={t('shell.search')} className="max-w-sm" />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <AccountMenu />
          </div>
        </header>
        {/* Below md the section menu lives in the off-canvas rail; a panel group would still reserve its
            256 px (the panel's own inline `display: flex` beats a `hidden` class). */}
        {section !== undefined && menu.length > 0 && !isMobile ? (
          <SectionMenuFrame
            section={section}
            items={menu}
            pathname={pathname}
            scroller={pageScroller}
          >
            {children}
          </SectionMenuFrame>
        ) : (
          <div ref={pageScroller} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <ShellBreadcrumbs />
            {children}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}

/**
 * The section menu beside the page, in a resizable panel. Its width is read when the panel
 * appears and then left alone (the library takes `defaultSize` as the starting size); the width a
 * person drags it to is kept per browser, and layouts the library sets itself (on mount, on a
 * change of the window) are not a choice and are not kept.
 */
function SectionMenuFrame({
  section,
  items,
  pathname,
  scroller,
  children,
}: {
  readonly section: NavSection
  readonly items: readonly NavItem[]
  readonly pathname: string
  /** The element whose scroll position resets when the address changes. */
  readonly scroller: RefObject<HTMLDivElement | null>
  readonly children: ReactNode
}): ReactNode {
  const panel = usePanelRef()
  const [width] = useState(readSectionMenuWidth)
  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1"
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
      <ResizablePanel id="page" className="min-w-0">
        <div ref={scroller} className="h-full min-w-0 overflow-auto">
          <ShellBreadcrumbs />
          {children}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function RailItem({
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
  // On a small screen the rail is a sheet: the section pages are listed under their section.
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
          <section.icon aria-hidden="true" />
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
      className="flex h-full flex-col gap-2 overflow-y-auto border-r border-default bg-dash-sidebar px-3 py-4"
    >
      <p className="px-2 text-sm font-medium text-foreground">{section.label}</p>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = current?.id === item.id
          return (
            <li key={item.id}>
              <Link
                href={item.path}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex rounded-md px-2 py-1.5 text-sm focus-ring',
                  active
                    ? 'bg-selection font-medium text-foreground'
                    : 'text-foreground-light hover:bg-surface-200 hover:text-foreground',
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
