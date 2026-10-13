import type { Readable } from '@exponetdb/ui-patterns'
import { createContext, type ReactNode, useContext } from 'react'
import type { TargetRoute } from './params.ts'
import type { Target } from './queries.ts'

/**
 * The target a page below `/t/<product>/<project>/<environment>` belongs to:
 * the validated route and the one read of the target the layout started.
 * Pages take it from here instead of reading the target again, and they pass
 * `read` to `ContentWrapper`, which turns it into the loading, failed,
 * suspended and decommissioned states.
 */
export interface TargetScopeValue {
  readonly target: TargetRoute
  readonly read: Readable<Target>
  readonly refetch: () => void
  readonly fetching: boolean
}

const TargetScope = createContext<TargetScopeValue | undefined>(undefined)

export function TargetScopeProvider(props: {
  readonly value: TargetScopeValue
  readonly children: ReactNode
}): ReactNode {
  return <TargetScope.Provider value={props.value}>{props.children}</TargetScope.Provider>
}

export function useTargetScope(): TargetScopeValue {
  const value = useContext(TargetScope)
  if (value === undefined) {
    throw new Error('useTargetScope() outside the target layout')
  }
  return value
}
