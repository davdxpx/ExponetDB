import { CommandMenu, CommandProvider, ShortcutProvider } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { TargetContextBar } from '../../src/features/target/context-bar.tsx'

/**
 * The part of the app shell the target pages depend on, without the
 * navigation rail: the shortcut and command providers of the real shell
 * (strict, as in development, so a binding used twice throws) and the
 * context bar in a header. Tests of the target feature mock
 * `src/shell/app-shell.tsx` with it, so they do not move when the shell
 * does; `TargetContextBar` is rendered here once, as the shell renders it.
 */
export function TestShell({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <ShortcutProvider strict>
      <CommandProvider>
        <header>
          <TargetContextBar />
        </header>
        <main id="content" tabIndex={-1}>
          {children}
        </main>
        <CommandMenu />
      </CommandProvider>
    </ShortcutProvider>
  )
}
