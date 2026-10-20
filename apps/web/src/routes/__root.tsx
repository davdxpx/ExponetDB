import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'
import { RouteErrorPage } from '../app/error-page.tsx'
import { titleOf } from '../app/title.ts'
import { NotFoundPage } from '../shell/not-found.tsx'

/**
 * The root of the client routes. A path no route knows renders "page not
 * found" in the page (the server answers every page path with the app,
 * ADR-0031); it never redirects and never shows the address it was given.
 * Signed-in paths below the shell are caught by `_app/$` first, so the shell,
 * its command menu and its shortcuts stay. A route that fails to render shows the crash page
 * (`RouteErrorPage`): the router's own fallback prints the exception's message, and the root
 * has one too, so a tree built without `createAppRouter` never shows it.
 */
export const Route = createRootRoute({
  errorComponent: RouteErrorPage,
  component: () => (
    <>
      <DocumentTitle />
      <Outlet />
    </>
  ),
  notFoundComponent: () => <NotFoundPage landmark />,
})

/** Keeps `document.title` on "<Page> · ExponetDB" for the current page (`src/app/title.ts`). */
function DocumentTitle(): ReactNode {
  const title = useRouterState({
    select: (state) =>
      titleOf(
        state.location.pathname,
        state.matches.map((match) => match.staticData?.title),
      ),
  })
  useEffect(() => {
    document.title = title
  }, [title])
  return null
}
