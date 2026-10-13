import { PanelLeft } from '@exponetdb/icons'
import {
  Button,
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
  useSidebar,
} from '@exponetdb/ui'
import {
  CommandMenu,
  CommandMenuTriggerInput,
  CommandProvider,
  ShortcutProvider,
  useLinkComponent,
  useNavigate,
} from '@exponetdb/ui-patterns'
import { useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Fragment, type ReactNode } from 'react'
import { useApi } from '../lib/api/context.tsx'
import { t } from '../lib/i18n/i18n.ts'
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
  const section = sectionOf(pathname)
  const menu = section === undefined ? [] : sectionMenu(section.id)
  return (
    <SidebarProvider open={mode === 'open'} onOpenChange={toggleSidebarMode}>
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
      <SidebarInset id="content" tabIndex={-1} className="min-w-0 outline-none">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-default px-3">
          <SidebarTrigger />
          <CommandMenuTriggerInput placeholder={t('shell.search')} className="max-w-sm" />
          <div className="ml-auto flex items-center gap-2">
            <ThemeMenu />
            <AccountMenu />
          </div>
        </header>
        {section !== undefined && menu.length > 0 ? (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel
              id="section-menu"
              defaultSize={256}
              minSize={200}
              maxSize={400}
              groupResizeBehavior="preserve-pixel-size"
              className="hidden md:block"
            >
              <SectionMenu section={section} items={menu} pathname={pathname} />
            </ResizablePanel>
            <ResizableHandle
              className="hidden md:flex"
              aria-label={t('shell.sectionMenu.resize')}
            />
            <ResizablePanel id="page" className="min-w-0">
              <div className="h-full min-w-0 overflow-auto">{children}</div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="min-w-0 flex-1">{children}</div>
        )}
      </SidebarInset>
    </SidebarProvider>
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
  // On a small screen the rail is a sheet: the section pages are listed under their section.
  const pages = isMobile ? sectionMenu(section.id) : []
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={current} tooltip={section.label}>
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

function ThemeMenu(): ReactNode {
  const preference = useThemePreference()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="text" size="small">
          {t('shell.theme')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('shell.theme')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) =>
            setThemePreference(parseThemePreference(value), document.documentElement)
          }
        >
          <DropdownMenuRadioItem value="system">{t('shell.theme.system')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">{t('shell.theme.light')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t('shell.theme.dark')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu(): ReactNode {
  const me = useMe()
  const { client } = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // The display name is text the person chose: rendered as text only (C-26).
  const name = me.identity.displayName ?? me.identity.email ?? me.identity.label
  const signOut = (): void => {
    void client
      .ceremony('/auth/logout')
      .catch(() => undefined)
      .finally(() => {
        // Signed out, or the session had already ended: nothing of it stays in memory.
        queryClient.clear()
        window.location.assign('/login')
      })
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="default" size="small">
          {t('shell.account')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="max-w-64 truncate">{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/account')}>
          {t('shell.account.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem id="sign-out" onSelect={signOut}>
          {t('shell.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
