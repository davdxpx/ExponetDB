import type { CommandShortcutId } from '@exponetdb/ui-patterns'
import type { ResponseOf } from '../../lib/api/client.ts'
import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import { switchEnvironment, targetHref } from '../../shell/navigation.ts'
import { splitTargetPath, type TargetRoute } from './params.ts'

/**
 * The environments of one product and project, as the environment switcher
 * and the "Switch environment" commands read them (information-architecture.md
 * section 3). Everything here is a pure function of the `listTargets` answer:
 * the tier is the target's `tier` field, never a guess from its slug (an
 * environment named `prod` whose tier is `nonprod` is not production).
 */
export type Tier = 'prod' | 'nonprod'
export type Lifecycle = 'registered' | 'active' | 'suspended' | 'decommissioned'

/** The word a menu shows next to a target that is not active; `undefined` for an active one. */
export function lifecycleLabelKey(state: Lifecycle): MessageKey | undefined {
  switch (state) {
    case 'registered':
      return 'target.lifecycle.registered'
    case 'active':
      return undefined
    case 'suspended':
      return 'target.lifecycle.suspended'
    case 'decommissioned':
      return 'target.lifecycle.decommissioned'
  }
}

export interface Environment {
  readonly id: string
  /** `<product>/<project>/<environment>`. */
  readonly path: string
  /** The environment's slug (validated against the slug grammar). */
  readonly slug: string
  readonly tier: Tier
  readonly state: Lifecycle
}

export interface EnvironmentList {
  readonly environments: readonly Environment[]
  /** What the answer does not hold, in words (a partial read); empty when it is complete. */
  readonly missing: readonly string[]
}

type TargetPage = ResponseOf<'listTargets'>

/**
 * The environments of `product/project` in a `listTargets` page: nonproduction
 * first, then by slug. An item whose path is not three slugs of this product
 * and project is left out and reported as missing (it cannot be shown or
 * linked safely), and so is everything behind `nextCursor`.
 */
export function toEnvironmentList(
  page: TargetPage,
  product: string,
  project: string,
): EnvironmentList {
  const environments: Environment[] = []
  const seen = new Set<string>()
  let unreadable = 0
  for (const item of page.items) {
    const parsed = splitTargetPath(item.path)
    if (
      parsed === undefined ||
      parsed.product !== product ||
      parsed.project !== project ||
      seen.has(parsed.environment)
    ) {
      unreadable += 1
      continue
    }
    seen.add(parsed.environment)
    environments.push({
      id: item.id,
      path: item.path,
      slug: parsed.environment,
      tier: item.tier,
      state: item.state,
    })
  }
  environments.sort(
    (a, b) =>
      Number(a.tier === 'prod') - Number(b.tier === 'prod') ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  )
  const missing: string[] = []
  if (page.nextCursor !== null) missing.push(t('target.switcher.missing.more'))
  if (unreadable > 0) missing.push(t('target.switcher.missing.unreadable'))
  return { environments, missing }
}

/**
 * Where the same page lives on another environment of the project: the
 * section and a schema kind survive, an object name does not
 * (`switchEnvironment`). Falls back to the environment's own overview.
 */
export function environmentHref(target: TargetRoute, pathname: string, slug: string): string {
  return (
    switchEnvironment(pathname, slug) ??
    targetHref({ product: target.product, project: target.project, environment: slug })
  )
}

export type EnvironmentShortcutId = Extract<
  CommandShortcutId,
  'env.production' | 'env.staging' | 'env.development'
>

export interface EnvironmentShortcut {
  readonly shortcut: EnvironmentShortcutId
  readonly environment: Environment
}

/**
 * The environment each `E`-then-letter shortcut goes to, among the
 * environments of the project: `env.staging` and `env.development` to the one
 * whose slug is exactly that word; `env.production` to the one whose slug is
 * `production`, else to the only environment of tier `prod` (none when
 * several have that tier). A shortcut without such an environment stays
 * unbound, and so does one that would only lead to the environment the
 * person is on.
 */
export function environmentShortcuts(
  environments: readonly Environment[],
  currentSlug: string,
): readonly EnvironmentShortcut[] {
  const bySlug = (slug: string): Environment | undefined =>
    environments.find((e) => e.slug === slug)
  const productionTier = environments.filter((e) => e.tier === 'prod')
  const production =
    bySlug('production') ?? (productionTier.length === 1 ? productionTier[0] : undefined)
  const picks: readonly (readonly [EnvironmentShortcutId, Environment | undefined])[] = [
    ['env.production', production],
    ['env.staging', bySlug('staging')],
    ['env.development', bySlug('development')],
  ]
  const bound: EnvironmentShortcut[] = []
  for (const [shortcut, environment] of picks) {
    if (environment !== undefined && environment.slug !== currentSlug) {
      bound.push({ shortcut, environment })
    }
  }
  return bound
}
