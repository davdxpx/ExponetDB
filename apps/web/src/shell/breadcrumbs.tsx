import { PageBreadcrumbs } from '@exponetdb/ui-patterns'
import { useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { breadcrumbTrail } from './breadcrumb-trail.ts'

/**
 * The breadcrumb row above a detail page ("Changes › Plans › pln_…",
 * "Infrastructure › Servers › srv_…", "Databases › shop/platform/staging ›
 * Schema › tables"), drawn by the shell from the route that is matched, so
 * the pages themselves stay as they are. A page that has no trail (every
 * list and section page), or whose id or slug fails its grammar, gets no row.
 */
export function ShellBreadcrumbs(): ReactNode {
  const match = useRouterState({ select: (state) => state.matches.at(-1) })
  if (match === undefined) return null
  const params: Readonly<Record<string, unknown>> = match.params
  const trail = breadcrumbTrail(match.routeId, params)
  if (trail === undefined) return null
  return <PageBreadcrumbs items={trail} />
}
