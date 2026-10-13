import { createRootRoute, Outlet } from '@tanstack/react-router'
import { NotFoundPage } from '../shell/not-found.tsx'

/**
 * The root of the client routes. A path no route knows renders "page not
 * found" in the page (the server answers every page path with the app,
 * ADR-0031); it never redirects and never shows the address it was given.
 * Signed-in paths below the shell are caught by `_app/$` first, so the shell,
 * its command menu and its shortcuts stay.
 */
export const Route = createRootRoute({
  component: () => <Outlet />,
  notFoundComponent: () => <NotFoundPage landmark />,
})
