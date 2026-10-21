import { SidebarProvider } from '@exponetdb/ui'
import { CommandMenu, CommandProvider, ShortcutProvider } from '@exponetdb/ui-patterns'
import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { TargetContextBar } from '../../src/features/target/context-bar.tsx'
import { targetOfPathname } from '../../src/features/target/params.ts'
import { TargetRail } from '../../src/shell/rail.tsx'

/**
 * The part of the app shell the target pages depend on, without the fleet's
 * rail and the rest of the frame: the shortcut and command providers of the
 * real shell (strict, as in development, so a binding used twice throws), the
 * context bar in a header and, on a target's page, the target's rail. Tests of
 * the target feature mock `src/shell/app-shell.tsx` with it, so they do not
 * move when the frame does; `TargetContextBar` and `TargetRail` are rendered
 * here once, as the shell renders them.
 */
export function TestShell({ children }: { readonly children: ReactNode }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const target = targetOfPathname(pathname)
  return (
    <ShortcutProvider strict>
      <CommandProvider>
        <SidebarProvider>
          <header>
            <TargetContextBar />
          </header>
          {target === undefined ? null : <TargetRail target={target} pathname={pathname} />}
          <main id="content" tabIndex={-1}>
            {children}
          </main>
        </SidebarProvider>
        <CommandMenu />
      </CommandProvider>
    </ShortcutProvider>
  )
}
