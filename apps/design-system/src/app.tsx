import { useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { AREA_LABELS, AREAS } from './content/meta.ts'
import { PAGES, pageAt } from './content/registry.ts'
import { CspSurfacePage } from './csp-surface/page.tsx'
import { RoutingProvider, useLocation } from './router.tsx'
import { mdxComponents } from './site/mdx-components.tsx'
import { SiteLayout } from './site/site-layout.tsx'
import { VisualHost } from './site/visual-host.tsx'

function Home(): ReactNode {
  const Link = useLinkComponent()
  return (
    <SiteLayout current="/">
      <h1 className="mb-2 text-3xl font-medium tracking-tight">ExponetDB design system</h1>
      <p className="mb-6 text-sm text-foreground-light">
        Guidance, components and patterns of the ExponetDB Web App. Read the guidance and the page
        of each component before building a screen. The same pages are available as Markdown in{' '}
        <code className="font-mono text-xs">llms.txt</code> for coding agents.
      </p>
      {AREAS.map((area) => {
        const pages = PAGES.filter((page) => page.area === area)
        if (pages.length === 0) return null
        return (
          <section key={area} className="mb-6">
            <h2 className="mb-2 text-lg font-medium">{AREA_LABELS[area]}</h2>
            <ul className="flex flex-col gap-1.5">
              {pages.map((page) => (
                <li key={page.path} className="text-sm">
                  <Link
                    href={page.path}
                    className="font-medium text-foreground underline focus-ring"
                  >
                    {page.title}
                  </Link>
                  <span className="text-foreground-light">: {page.description}</span>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      <p className="text-sm">
        <Link href="/csp-surface" className="underline focus-ring">
          CSP surface
        </Link>{' '}
        and{' '}
        <Link href="/visual" className="underline focus-ring">
          visual regression host
        </Link>
      </p>
    </SiteLayout>
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
  if (path === '/visual') return <VisualHost />
  const page = pageAt(path)
  if (page === undefined) return <NotFound />
  return (
    <SiteLayout current={page.path}>
      <page.Content components={mdxComponents} />
    </SiteLayout>
  )
}

/** The design-system app: a static site with guidance, demos and the CSP surface. */
export function App(): ReactNode {
  return (
    <RoutingProvider>
      <Routes />
    </RoutingProvider>
  )
}
