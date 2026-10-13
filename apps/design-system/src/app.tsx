import type { ReactNode } from 'react'
import { CspSurfacePage } from './csp-surface/page.tsx'
import { RoutingProvider, useLocation } from './router.tsx'

function Home(): ReactNode {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">ExponetDB design system</h1>
      <p>Guidance, components and patterns of the ExponetDB Web App.</p>
      <ul className="mt-4">
        <li>
          <a href="/csp-surface">CSP surface</a>
        </li>
      </ul>
    </main>
  )
}

function NotFound(): ReactNode {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p>
        <a href="/">Back to the overview</a>
      </p>
    </main>
  )
}

function Routes(): ReactNode {
  const { path } = useLocation()
  if (path === '/') return <Home />
  if (path === '/csp-surface') return <CspSurfacePage />
  return <NotFound />
}

/** The design-system app: a static site with guidance, demos and the CSP surface. */
export function App(): ReactNode {
  return (
    <RoutingProvider>
      <Routes />
    </RoutingProvider>
  )
}
