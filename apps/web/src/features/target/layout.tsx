import { cn } from '@exponetdb/ui'
import { isProductionTier, readableValue } from '@exponetdb/ui-patterns'
import { Outlet } from '@tanstack/react-router'
import { type ReactNode, useMemo } from 'react'
import { NotFoundPage } from '../../shell/not-found.tsx'
import { EnvironmentCommands } from './environment-commands.tsx'
import { parseTargetParams, type TargetParams, type TargetRoute } from './params.ts'
import { useTarget } from './queries.ts'
import { TargetScopeProvider } from './scope.tsx'
import { TargetNav } from './target-nav.tsx'

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
 * - the target sections as a navigation, the commands "Switch environment",
 *   and the page in an outlet keyed by the target's id, so switching
 *   environment remounts everything the page keeps for its target (tabs,
 *   filters, drafts);
 * - on a production target the root carries `data-tier="production"` and the
 *   outlet a production frame (the reserved `production` token); the chip with
 *   the word "Production" is in the header and in each page title.
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
  if (read.notFound) return <NotFoundPage />
  const value = readableValue(read.readable)
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
        <TargetNav target={target} />
        <div
          key={outletKey}
          data-slot="target-outlet"
          data-production-frame={production ? '' : undefined}
          className={cn('min-w-0 flex-1', production && 'border-2 border-production')}
        >
          <Outlet />
        </div>
      </div>
    </TargetScopeProvider>
  )
}
