import { isProductionTier, readableValue } from '@exponetdb/ui-patterns'
import { Outlet } from '@tanstack/react-router'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useMe } from '../../lib/session/guard.tsx'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { EnvironmentCommands } from './environment-commands.tsx'
import { parseTargetParams, type TargetParams, type TargetRoute } from './params.ts'
import { useTarget } from './queries.ts'
import { rememberTarget } from './recent-storage.ts'
import { TargetScopeProvider } from './scope.tsx'
import { TargetSectionCommands } from './section-commands.tsx'

/**
 * The layout of every page below `/t/<product>/<project>/<environment>`
 * (information-architecture.md sections 2.2 and 3):
 *
 * - the three route parameters must match the slug grammar exactly, or the
 *   shell's "page not found" renders and nothing is requested (a parameter
 *   that failed is never rendered);
 * - the target is read once (`useTarget`); a `NOT_FOUND` answer renders the
 *   same "page not found", whether the target does not exist or is not
 *   visible to the person;
 * - the commands "Switch environment" and the commands that open a section
 *   of this target (the sections themselves are the shell's rail at the
 *   target's level, as Studio lists a project's products), and the page in an
 *   outlet keyed by the target's id, so switching environment remounts
 *   everything the page keeps for its target (tabs, filters, drafts);
 * - a target that was read is remembered as one of the person's recent
 *   databases (five at most, in this browser, under the person's id);
 * - on a production target the root carries `data-tier="production"`; the
 *   chip with the word "Production" is in the header's path and in each page
 *   title (a frame around the whole page is for plans only, design-system.md
 *   §4).
 *
 * Pages read the target from `useTargetScope()` and gate their content with
 * `ContentWrapper`; the layout itself renders the loading and failed states
 * of the target read only through that wrapper, never as "not found".
 */
export function TargetLayout({ params }: { readonly params: TargetParams }): ReactNode {
  const { product, project, environment } = params
  const target = useMemo(
    () => parseTargetParams({ product, project, environment }),
    [product, project, environment],
  )
  if (target === undefined) return <NotFoundPage />
  return <ValidTargetLayout target={target} />
}

function ValidTargetLayout({ target }: { readonly target: TargetRoute }): ReactNode {
  const read = useTarget(target.path)
  const identityId = useMe().identity.id
  const value = readableValue(read.readable)
  const known = value !== undefined && !read.notFound
  // Only a target the server answered for is remembered, never a path someone typed.
  useEffect(() => {
    if (known) rememberTarget(identityId, target.path)
  }, [known, identityId, target.path])
  if (read.notFound) return <NotFoundPage />
  const production = value !== undefined && isProductionTier(value.tier)
  // The id once the target is known; its path until then, so a switch always remounts.
  const outletKey = value?.id ?? `path:${target.path}`
  return (
    <TargetScopeProvider
      value={{
        target,
        read: read.readable,
        refetch: read.refetch,
        fetching: read.fetching,
      }}
    >
      <div
        data-slot="target-layout"
        data-tier={value === undefined ? undefined : production ? 'production' : 'nonprod'}
        className="flex min-w-0 flex-col"
      >
        <EnvironmentCommands target={target} />
        <TargetSectionCommands target={target} />
        <div key={outletKey} data-slot="target-outlet" className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </TargetScopeProvider>
  )
}
