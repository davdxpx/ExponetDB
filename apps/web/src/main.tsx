// First: no schema may be built before zod is jitless (src/app/zod-jitless.ts).
import './app/zod-jitless.ts'
import { isAppPath } from '@exponetdb/ui-patterns'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProviders, type AppServices } from './app/providers.tsx'
import { createAppRouter } from './app/router.ts'
import { holdOneTimeLink } from './features/enrollment/link.ts'
import { createReauthBridge } from './features/reauth/reauth.tsx'
import { ApiClient } from './lib/api/client.ts'
import { initLetterShortcuts } from './lib/preferences/shortcuts.ts'
import { initSidebarMode } from './lib/preferences/sidebar.ts'
import { initTheme } from './lib/preferences/theme.ts'
import { createQueryClient } from './lib/query/client.ts'
import { leaveForSignIn } from './lib/session/session.ts'
import './styles/app.css'

// A one-time link's token leaves the address bar and the history first, before the router,
// the API client or anything else runs; only its page redeems it, from memory.
holdOneTimeLink(window.location, window.history)

initTheme(document.documentElement)
initLetterShortcuts()
initSidebarMode()

const queryClient = createQueryClient()
const client = new ApiClient({
  fetch: (input, init) => fetch(input, init),
  cookies: () => document.cookie,
  onSessionGone: () => leaveForSignIn({ location, clearCache: () => queryClient.clear() }),
})
const router = createAppRouter()

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const services: AppServices = {
  queryClient,
  client,
  reauth: createReauthBridge(),
  navigate: (path, options) => {
    // Only app paths: a full URL, a protocol-relative path or one a browser would read
    // as another origin never reaches the router.
    if (!isAppPath(path)) return
    void router.navigate({ href: path, replace: options?.replace === true })
  },
}

const root = document.getElementById('root')
if (root === null) {
  throw new Error('the page has no #root element')
}
createRoot(root).render(
  <StrictMode>
    <AppProviders services={services}>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
