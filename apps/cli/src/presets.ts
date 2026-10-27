import {
  isDeviceFlowScope,
  isScope,
  isScopeGrantableTo,
  type Scope,
  scopeDefinition,
} from '@exponetdb/contracts'

/**
 * Named scope presets for `exponetdb login --preset`
 * ([`15-cli/README.md` §3](../../../exponetdb-docs/15-cli/README.md#sign-in-scopes-and-presets)).
 * A preset is shorthand for a scope list and nothing more: the consent page
 * still offers only what the person holds, production stays its own preset
 * (and its own opt-in in the browser), and the device flow refuses a preset
 * with an explicit-consent scope like any explicit list. Never in a preset,
 * so always named with `--scope`: `restore.execute`, `operations.recover`,
 * `breakglass.activate`, `diagnostics.read_sensitive`, `data.read_sensitive`.
 */
const READ = [
  'targets.read',
  'schema.read',
  'migrations.read',
  'diagnostics.read',
  'backups.read',
  'nodes.read',
  'audit.read',
] as const satisfies readonly Scope[]
const DEVELOPER_NONPROD = [...READ, 'migrations.plan', 'migrations.apply:nonprod'] as const
const OPERATOR_NONPROD = [
  ...DEVELOPER_NONPROD,
  'data.read:nonprod',
  'connections.operate:nonprod',
  'backups.run',
  'restore.plan',
  'nodes.plan',
  'nodes.operate:nonprod',
] as const

export interface ScopePreset {
  readonly summary: string
  readonly scopes: readonly Scope[]
}

export const SCOPE_PRESETS = {
  read: {
    summary: 'Read targets, schemas, migrations, diagnostics, backups, nodes and audit.',
    scopes: READ,
  },
  'developer:nonprod': {
    summary: 'read, plus planning migrations and applying them outside production.',
    scopes: DEVELOPER_NONPROD,
  },
  'developer:prod': {
    summary: 'developer:nonprod, plus applying migrations on production.',
    scopes: [...DEVELOPER_NONPROD, 'migrations.apply:prod'],
  },
  'operator:nonprod': {
    summary:
      'developer:nonprod, plus data reads, connections and nodes outside production, and backup runs and restore plans on every tier (those two scopes carry no tier).',
    scopes: OPERATOR_NONPROD,
  },
  'operator:prod': {
    summary: 'operator:nonprod, plus the same on production.',
    scopes: [
      ...OPERATOR_NONPROD,
      'migrations.apply:prod',
      'data.read:prod',
      'connections.operate:prod',
      'nodes.operate:prod',
    ],
  },
  admin: {
    summary: 'developer:nonprod, plus the registry, access, policy, legacy import and drift.',
    scopes: [
      ...DEVELOPER_NONPROD,
      'registry.manage',
      'access.read',
      'access.manage',
      'policy.manage',
      'migrations.import',
      'schema.manage',
    ],
  },
} as const satisfies Record<string, ScopePreset>

export type PresetName = keyof typeof SCOPE_PRESETS

export const PRESET_NAMES = Object.keys(SCOPE_PRESETS) as PresetName[]

export function isPreset(value: string): value is PresetName {
  return Object.hasOwn(SCOPE_PRESETS, value)
}

/** Scopes of the contract the first-party CLI may hold. */
export function isCliScope(value: string): value is Scope {
  return isScope(value) && isScopeGrantableTo(value, 'cli')
}

/** A space or comma separated scope string as a list (as the token response gives it). */
export function scopeList(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).filter((s) => s.length > 0))]
}

/** The scopes of `scopes` the device flow never carries. */
export function deviceRefused(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !isScope(s) || !isDeviceFlowScope(s))
}

export function presetMissing(name: PresetName, granted: readonly string[]): Scope[] {
  return SCOPE_PRESETS[name].scopes.filter((s) => !granted.includes(s))
}

/**
 * The preset with the fewest scopes that holds all of `wanted`, if one does;
 * never one that adds a production scope `wanted` does not name.
 */
export function smallestPresetCovering(wanted: readonly string[]): PresetName | undefined {
  return PRESET_NAMES.filter((name) => {
    const scopes: readonly Scope[] = SCOPE_PRESETS[name].scopes
    return (
      wanted.every((s) => (scopes as readonly string[]).includes(s)) &&
      scopes.every((s) => wanted.includes(s) || scopeDefinition(s).tier !== 'prod')
    )
  }).sort((a, b) => SCOPE_PRESETS[a].scopes.length - SCOPE_PRESETS[b].scopes.length)[0]
}

/**
 * The sign-ins that would allow a command refused for a missing scope: the
 * scopes granted now plus the required ones (a new sign-in replaces the
 * grant, so nothing held is dropped), as the smallest covering preset when
 * one exists and always as an explicit list.
 */
/** Production scopes are its own opt-in each time (C-24): never part of the remembered request. */
export function rememberable(scopes: readonly string[]): string[] {
  return scopes.filter((s) => isScope(s) && scopeDefinition(s).tier !== 'prod')
}

export function scopeHint(
  granted: readonly string[],
  required: readonly string[],
  on: string,
): string[] {
  // A scope the CLI can never hold (a Web App scope) is not won by signing in again.
  if (!required.some(isCliScope)) return []
  const wanted = [...new Set([...granted, ...required])].filter(isCliScope)
  const preset = smallestPresetCovering(wanted)
  return [
    ...(preset === undefined ? [] : [`exponetdb login${on} --preset ${preset}`]),
    `exponetdb login${on} --scope "${wanted.join(' ')}"`,
  ]
}

export interface ScopeReport {
  readonly granted: readonly string[]
  /** Asked for at the last sign-in but not granted (known only with an oauth profile). */
  readonly notGranted: readonly string[] | null
  readonly presets: readonly {
    readonly preset: PresetName
    readonly covered: boolean
    readonly missing: readonly Scope[]
  }[]
}

/** Granted scopes against the presets and the last request, for `whoami` and `doctor`. */
export function scopeReport(
  granted: readonly string[],
  requested?: readonly string[],
): ScopeReport {
  return {
    granted,
    notGranted: requested === undefined ? null : requested.filter((s) => !granted.includes(s)),
    presets: PRESET_NAMES.map((preset) => {
      const missing = presetMissing(preset, granted)
      return { preset, covered: missing.length === 0, missing }
    }),
  }
}
