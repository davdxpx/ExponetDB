import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
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
import type { ReactNode } from 'react'
import { useApi } from '../lib/api/context.tsx'
import { t } from '../lib/i18n/i18n.ts'
import { setLetterShortcuts, useLetterShortcuts } from '../lib/preferences/shortcuts.ts'
import {
  parseThemePreference,
  setThemePreference,
  useThemePreference,
} from '../lib/preferences/theme.ts'
import { useMe } from '../lib/session/guard.tsx'
import { ShellCommands } from './commands.tsx'
import { GLOBAL_NAV, type NavItem } from './navigation.ts'

/**
 * The frame of every signed-in page (information-architecture.md §2): the
 * global navigation from the IA data (one list feeds the shell, the command
 * menu and the shortcut sheet), a header with the theme and account menus,
 * and the page in a `main` landmark that a skip link reaches first. Pages
 * whose data arrives with a later wave are listed and say so on the page.
 */
const GROUPS: readonly { readonly id: NavItem['group']; readonly label: string }[] = [
  { id: 'fleet', label: 'Fleet' },
  { id: 'changes', label: 'Changes' },
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'access', label: 'Access' },
  { id: 'records', label: 'Records' },
  { id: 'settings', label: 'Settings' },
]

/** Whether a navigation item is the current section: its path or a page below it. */
export function isCurrent(itemPath: string, pathname: string): boolean {
  if (itemPath === '/') return pathname === '/'
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`)
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
  const Link = useLinkComponent()
  return (
    <SidebarProvider>
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-100 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus-ring"
      >
        {t('shell.skip')}
      </a>
      <Sidebar collapsible="offcanvas" label={t('shell.navigation')}>
        <SidebarHeader>
          <Link href="/" className="px-2 py-1 text-base font-semibold text-foreground">
            {t('app.name')}
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label={t('shell.navigation')}>
            {GROUPS.map((group) => (
              <SidebarGroup key={group.id}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {GLOBAL_NAV.filter((item) => item.group === group.id).map((item) => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton asChild isActive={isCurrent(item.path, pathname)}>
                          <Link
                            href={item.path}
                            aria-current={isCurrent(item.path, pathname) ? 'page' : undefined}
                          >
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>
      </Sidebar>
      {/* SidebarInset is the page's `main` landmark, the target of the skip link. */}
      <SidebarInset id="content" tabIndex={-1} className="min-w-0 outline-none">
        <header className="flex h-12 items-center gap-2 border-b border-default px-3">
          <SidebarTrigger />
          <CommandMenuTriggerInput placeholder={t('shell.search')} className="max-w-sm" />
          <div className="ml-auto flex items-center gap-2">
            <ThemeMenu />
            <AccountMenu />
          </div>
        </header>
        <div className="min-w-0 flex-1">{children}</div>
      </SidebarInset>
    </SidebarProvider>
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
