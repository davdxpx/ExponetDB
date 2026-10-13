import { type MessageKey, t } from '../../lib/i18n/i18n.ts'
import type { PolicyRule } from './keys.ts'

/**
 * The policy settings as the page shows them (policy-engine.md §5): for one
 * rule, the latest revision per scope and the parameters in effect at the
 * installation (the defaults, overridden per parameter by the latest
 * installation revision). The `data.read` rule's modes and column patterns
 * are checked here the way the rule checks them (`validDataReadParams`), so
 * a person learns a mistake before a plan is made; the server checks again.
 */
export type Setting = PolicyRule['settings'][number]
type Json = PolicyRule['defaults'][string]

export const DATA_READ_RULE = 'data.read'
export const DATA_READ_MODES = ['by_tier', 'enabled', 'humans_only', 'disabled'] as const
export type DataReadMode = (typeof DATA_READ_MODES)[number]

export function isDataReadMode(value: unknown): value is DataReadMode {
  return typeof value === 'string' && (DATA_READ_MODES as readonly string[]).includes(value)
}

const PART = '[A-Za-z_*][A-Za-z0-9_$*]{0,62}'
export const SENSITIVE_COLUMN = new RegExp(`^${PART}\\.${PART}\\.${PART}$`)
export const SENSITIVE_COLUMNS_MAX = 256

/** The latest revision of each scope, installation first, then targets by id. */
export function latestSettings(rule: PolicyRule): Setting[] {
  const latest = new Map<string, Setting>()
  for (const setting of rule.settings) {
    const key = `${setting.scopeKind}:${setting.scopeId}`
    const seen = latest.get(key)
    if (seen === undefined || setting.revision > seen.revision) latest.set(key, setting)
  }
  return [...latest.values()].sort((a, b) =>
    a.scopeKind === b.scopeKind
      ? a.scopeId.localeCompare(b.scopeId)
      : a.scopeKind === 'installation'
        ? -1
        : b.scopeKind === 'installation'
          ? 1
          : a.scopeKind.localeCompare(b.scopeKind),
  )
}

/** The parameters in effect at the installation: defaults, then the latest installation revision. */
export function installationParams(rule: PolicyRule): Readonly<Record<string, Json>> {
  const installation = latestSettings(rule).find((setting) => setting.scopeKind === 'installation')
  return { ...rule.defaults, ...(installation?.params ?? {}) }
}

/** The parameters in effect at one target: the installation's, then the target's own revision. */
export function targetParams(rule: PolicyRule, targetId: string): Readonly<Record<string, Json>> {
  const own = latestSettings(rule).find(
    (setting) => setting.scopeKind === 'target' && setting.scopeId === targetId,
  )
  return { ...installationParams(rule), ...(own?.params ?? {}) }
}

const MODE_TEXT: Readonly<Record<DataReadMode, MessageKey>> = {
  by_tier: 'settings.policies.dataRead.mode.by_tier',
  enabled: 'settings.policies.dataRead.mode.enabled',
  humans_only: 'settings.policies.dataRead.mode.humans_only',
  disabled: 'settings.policies.dataRead.mode.disabled',
}

const MODE_LABEL: Readonly<Record<DataReadMode, MessageKey>> = {
  by_tier: 'settings.policies.dataRead.label.by_tier',
  enabled: 'settings.policies.dataRead.label.enabled',
  humans_only: 'settings.policies.dataRead.label.humans_only',
  disabled: 'settings.policies.dataRead.label.disabled',
}

export function modeLabel(mode: DataReadMode): string {
  return t(MODE_LABEL[mode])
}

export function modeText(mode: DataReadMode): string {
  return t(MODE_TEXT[mode])
}

/** Who reads rows on each tier under a mode: [production, non-production]. */
export function modeByTier(mode: DataReadMode): {
  readonly prod: string
  readonly nonprod: string
} {
  switch (mode) {
    case 'by_tier':
      return {
        prod: t('settings.policies.dataRead.who.people'),
        nonprod: t('settings.policies.dataRead.who.all'),
      }
    case 'enabled':
      return {
        prod: t('settings.policies.dataRead.who.all'),
        nonprod: t('settings.policies.dataRead.who.all'),
      }
    case 'humans_only':
      return {
        prod: t('settings.policies.dataRead.who.people'),
        nonprod: t('settings.policies.dataRead.who.people'),
      }
    case 'disabled':
      return {
        prod: t('settings.policies.dataRead.who.nobody'),
        nonprod: t('settings.policies.dataRead.who.nobody'),
      }
  }
}

/** The column patterns of a text area (one per line), or the first line that does not fit. */
export function parseColumns(
  text: string,
):
  | { readonly ok: true; readonly columns: string[] }
  | { readonly ok: false; readonly line: string } {
  const columns = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const bad = columns.find((column) => !SENSITIVE_COLUMN.test(column))
  if (bad !== undefined) return { ok: false, line: bad }
  if (columns.length > SENSITIVE_COLUMNS_MAX) return { ok: false, line: String(columns.length) }
  return { ok: true, columns: [...new Set(columns)] }
}

/** The column patterns of a parameter value as lines (anything else as nothing). */
export function columnsOf(value: Json | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** A JSON object typed by a person for a rule's parameters, or undefined when it is not one. */
export function parseParams(text: string): Record<string, Json> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const keys = Object.keys(parsed)
  if (keys.some((key) => !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key))) return undefined
  return parsed as Record<string, Json>
}

export function severityLabel(severity: PolicyRule['severity']): string {
  switch (severity) {
    case 'deny':
      return t('settings.policies.severity.deny')
    case 'require':
      return t('settings.policies.severity.require')
    case 'warn':
      return t('settings.policies.severity.warn')
  }
}
