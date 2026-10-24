import type { PolicySettings } from '@exponetdb/sdk/operations'
import type { Me } from '../../lib/session/guard.tsx'
import { type DataReadModel, dataReadOf } from '../configuration/data-read.ts'
import type { Target } from '../target/queries.ts'

/**
 * Whether the row browser is offered for a target, decided from what the page
 * can read: the person's `data.read` permission at the scopes that reach the
 * target (the tier follows from the scope: a binding on a non-production
 * environment does not reach a production target) and the target's data-read
 * setting. It is a reading aid, as `gateFor` is: the server admits every read
 * again and its refusal is shown as it is. Whatever the page cannot read is
 * not assumed either way: a setting it could not read leaves the browser open,
 * and the server's answer decides.
 */
export type BrowseGate =
  | { readonly kind: 'open' }
  | { readonly kind: 'not_permitted'; readonly permission: 'data.read'; readonly scope: string }
  | { readonly kind: 'reads_off' }

type Entry = Me['effectivePermissions'][number]
type Scope = Entry['scopes'][number]

type TargetIds = Pick<Target, 'id' | 'productId' | 'projectId' | 'environmentId' | 'tier'>

/** Whether a scope of a grant reaches the target. */
export function scopeReaches(scope: Scope, target: TargetIds): boolean {
  switch (scope.kind) {
    case 'global':
      return true
    case 'product':
      return scope.productId === target.productId
    case 'project':
      return scope.projectId === target.projectId
    case 'environment':
      return scope.environmentId === target.environmentId
    case 'target':
      return scope.targetId === target.id
  }
}

/**
 * Whether the person holds `data.read` for the target. An entry that lists no
 * scope does not say where it holds, so it is not read as "nowhere": the
 * server decides.
 */
export function holdsDataRead(permissions: readonly Entry[], target: TargetIds): boolean {
  const entry = permissions.find((candidate) => candidate.permission === 'data.read')
  if (entry === undefined) return false
  return entry.scopes.length === 0 || entry.scopes.some((scope) => scopeReaches(scope, target))
}

export function browseGate(input: {
  readonly permissions: readonly Entry[]
  readonly target: TargetIds
  /** The data-read setting that applies to the target, when the page could read it. */
  readonly policy: DataReadModel | undefined
}): BrowseGate {
  if (!holdsDataRead(input.permissions, input.target)) {
    return {
      kind: 'not_permitted',
      permission: 'data.read',
      scope: `data.read:${input.target.tier}`,
    }
  }
  // `by_tier` is `humans_only` on production: the Web App is a person, so both let a person read.
  if (input.policy?.mode === 'disabled') return { kind: 'reads_off' }
  return { kind: 'open' }
}

/** The data-read setting of a target from the policy settings read, or `undefined` when the read does not list it. */
export function dataReadFor(settings: PolicySettings, target: Target): DataReadModel | undefined {
  return dataReadOf(settings, {
    target: target.id,
    environment: target.environmentId,
    project: target.projectId,
    product: target.productId,
  })
}
