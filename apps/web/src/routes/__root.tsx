import { createRootRoute, Link, Outlet } from '@tanstack/react-router'
import { t } from '../lib/i18n/i18n.ts'

/**
 * The root of the client routes. A path no route knows renders "page not
 * found" in the page (the server answers every page path with the app,
 * ADR-0031); it never redirects and never shows the address it was given.
 */
export const Route = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => (
    <main className="mx-auto flex max-w-xl flex-col gap-3 p-6">
      <h1 className="text-2xl font-semibold">{t('page.notFound.title')}</h1>
      <p>{t('page.notFound.body')}</p>
      <p>
        <Link to="/" className="text-primary underline">
          {t('page.notFound.back')}
        </Link>
      </p>
    </main>
  ),
})
