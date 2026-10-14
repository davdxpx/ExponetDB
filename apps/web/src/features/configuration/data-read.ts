import type { PolicySettings } from '@exponetdb/sdk/operations'

/**
 * The data-read policy of a target as the policy settings list it (policy
 * rule `data.read`, ADR-0028): the most specific configured setting for the
 * target (target, then environment, project, product, installation), else the
 * rule's default. This is a reading aid: the server decides at every read, and
 * a setting that does not parse is shown as unreadable, never as a mode.
 */
export type DataReadScope = 'target' | 'environment' | 'project' | 'product' | 'installation'

export interface DataReadModel {
  /** Where the setting comes from; `default` when no revision is configured for the target. */
  readonly from: DataReadScope | 'default'
  readonly revision: number | null
  readonly mode: 'by_tier' | 'enabled' | 'humans_only' | 'disabled' | 'unreadable'
  readonly sensitiveColumns: readonly string[]
}

export interface TargetScopeIds {
  readonly target: string
  readonly environment: string
  readonly project: string
  readonly product: string
}

const MODES = ['by_tier', 'enabled', 'humans_only', 'disabled'] as const
const SPECIFICITY: readonly DataReadScope[] = [
  'target',
  'environment',
  'project',
  'product',
  'installation',
]

function modeOf(value: unknown): (typeof MODES)[number] | undefined {
  return MODES.find((candidate) => candidate === value)
}

function columnsOf(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : undefined
}

/** The data-read policy for a target, or `undefined` when the answer does not list the rule at all. */
export function dataReadOf(
  settings: PolicySettings,
  ids: TargetScopeIds,
): DataReadModel | undefined {
  const rule = settings.rules.find((candidate) => candidate.id === 'data.read')
  if (rule === undefined) return undefined
  let best: { scope: DataReadScope; rank: number; revision: number; params: unknown } | undefined
  for (const setting of rule.settings) {
    const scope = setting.scopeKind
    const matches = scope === 'installation' || ids[scope] === setting.scopeId
    if (!matches) continue
    const rank = SPECIFICITY.indexOf(scope)
    if (
      best === undefined ||
      rank < best.rank ||
      (rank === best.rank && setting.revision > best.revision)
    ) {
      best = { scope, rank, revision: setting.revision, params: setting.params }
    }
  }
  const params = best === undefined ? rule.defaults : best.params
  const record =
    typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
  const mode = modeOf(record['mode'])
  const columns = columnsOf(record['sensitiveColumns'])
  return {
    from: best?.scope ?? 'default',
    revision: best?.revision ?? null,
    mode: mode ?? 'unreadable',
    sensitiveColumns: columns ?? [],
  }
}
