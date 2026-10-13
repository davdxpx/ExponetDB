import { isAppPath } from '@exponetdb/ui-patterns'
import { createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProviders, type AppServices } from './app/providers.tsx'
import { createReauthBridge } from './features/reauth/reauth.tsx'
import { ApiClient } from './lib/api/client.ts'
import { initLetterShortcuts } from './lib/preferences/shortcuts.ts'
import { initSidebarMode } from './lib/preferences/sidebar.ts'
import { initTheme } from './lib/preferences/theme.ts'
import { createQueryClient } from './lib/query/client.ts'
import { leaveForSignIn } from './lib/session/session.ts'
import { routeTree } from './routeTree.gen.ts'
import './styles/app.css'

initTheme(document.documentElement)
initLetterShortcuts()
initSidebarMode()

const queryClient = createQueryClient()
const client = new ApiClient({
  fetch: (input, init) => fetch(input, init),
  cookies: () => document.cookie,
  onSessionGone: () => leaveForSignIn({ location, clearCache: () => queryClient.clear() }),
})
const router = createRouter({ routeTree, defaultPreload: 'intent' })

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
