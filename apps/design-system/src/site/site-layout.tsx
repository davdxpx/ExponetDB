import { cn } from '@exponetdb/ui'
import { useLinkComponent } from '@exponetdb/ui-patterns'
import type { ReactNode } from 'react'
import { AREA_LABELS, AREAS } from '../content/meta.ts'
import { PAGES } from '../content/registry.ts'

/**
 * The frame of the design-system site: a navigation of every page by area
 * (from the page registry) and the page in the `main` landmark. The site is
 * static and not deployed (OD-31); the same pages are exported as Markdown
 * for coding agents (`llms.txt`).
 */
export function SiteLayout({
  current,
  children,
}: {
  readonly current: string
  readonly children: ReactNode
}): ReactNode {
  const Link = useLinkComponent()
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <nav
        aria-label="Design system pages"
        className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-default bg-dash-sidebar px-4 py-6 md:block"
      >
        <Link href="/" className="mb-6 block text-base font-semibold text-foreground focus-ring">
          ExponetDB design system
        </Link>
        {AREAS.map((area) => {
          const pages = PAGES.filter((page) => page.area === area)
          if (pages.length === 0) return null
          return (
            <div key={area} className="mb-5">
              <p className="mb-1 px-2 text-xs font-medium tracking-wider text-foreground-lighter uppercase">
                {AREA_LABELS[area]}
              </p>
              <ul className="flex flex-col gap-0.5">
                {pages.map((page) => (
                  <li key={page.path}>
                    <Link
                      href={page.path}
                      aria-current={page.path === current ? 'page' : undefined}
                      className={cn(
                        'block rounded-md px-2 py-1 text-sm focus-ring',
                        page.path === current
                          ? 'bg-selection font-medium text-foreground'
                          : 'text-foreground-light hover:bg-surface-200 hover:text-foreground',
                      )}
                    >
                      {page.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>
      <main className="min-w-0 flex-1 px-6 py-8">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
    </div>
  )
}
