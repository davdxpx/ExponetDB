import { createFileRoute, Outlet } from '@tanstack/react-router'
import { RequireSession } from '../lib/session/guard.tsx'
import { AppShell } from '../shell/app-shell.tsx'

/** Every signed-in page: the session guard, then the shell around the page. */
export const Route = createFileRoute('/_app')({
  component: () => (
    <RequireSession>
      <AppShell>
        <Outlet />
      </AppShell>
    </RequireSession>
  ),
})
