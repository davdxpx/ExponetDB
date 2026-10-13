import { createFileRoute, Outlet } from '@tanstack/react-router'
import { RequireSession } from '../lib/session/guard.tsx'

/**
 * Pages that need a session but stand outside the shell: the interstitial
 * steps a link from the server, the CLI or MCP opens (step-up confirmation,
 * the credentials hand-off, OAuth consent and the device code). Without a
 * session the API client leaves for the sign-in page with a safe return
 * target; the page itself renders nothing of its subject meanwhile.
 */
export const Route = createFileRoute('/_session')({
  component: () => (
    <RequireSession>
      <Outlet />
    </RequireSession>
  ),
})
