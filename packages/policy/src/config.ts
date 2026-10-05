import {
  err,
  isJsonArray,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  ok,
  type Result,
} from '@exponetdb/kernel'
import type { SubjectScope } from './model.ts'
import type { Rule } from './rules.ts'

/**
 * Scoped configuration ([policy-engine.md §5](../../../exponetdb-docs/02-control-plane/policy-engine.md#5-policy-configuration)).
 * Settings rows live in the Control Store (`policy.rule_settings`,
 * append-only revisions); this module only resolves them. Levels, general to
 * specific: installation, product, project, environment, target. Per
 * parameter, the most specific level that sets it wins; a setting may only
 * set parameters the rule declares, with the type of the default. Never
 * environment variables (P-12).
 */
export const SCOPE_KINDS = ['installation', 'product', 'project', 'environment', 'target'] as const
export type ScopeKind = (typeof SCOPE_KINDS)[number]

export interface SettingRow {
  readonly scopeKind: ScopeKind
  readonly scopeId: string
  readonly ruleId: string
  readonly revision: number
  readonly params: JsonObject
}

export type ConfigRefusal = 'unknown_parameter' | 'invalid_parameter'

function scopeChain(subject: SubjectScope): readonly [ScopeKind, string][] {
  const chain: [ScopeKind, string][] = [['installation', 'installation']]
  if (subject.productId !== undefined) {
    chain.push(['product', subject.productId])
  }
  if (subject.projectId !== undefined) {
    chain.push(['project', subject.projectId])
  }
  if (subject.environmentId !== undefined) {
    chain.push(['environment', subject.environmentId])
  }
  if (subject.targetId !== undefined) {
    chain.push(['target', subject.targetId])
  }
  return chain
}

function jsonType(value: JsonValue | undefined): string {
  if (value === null) {
    return 'null'
  }
  if (isJsonArray(value)) {
    return 'array'
  }
  if (isJsonObject(value)) {
    return 'object'
  }
  return typeof value
}

/** The effective parameters of one rule for a subject. */
export function resolveParams(
  rule: Rule,
  rows: readonly SettingRow[],
  subject: SubjectScope,
): Result<JsonObject, ConfigRefusal> {
  const params: Record<string, JsonValue> = { ...rule.defaults }
  for (const [kind, id] of scopeChain(subject)) {
    let latest: SettingRow | undefined
    for (const row of rows) {
      if (row.ruleId === rule.id && row.scopeKind === kind && row.scopeId === id) {
        if (latest === undefined || row.revision > latest.revision) {
          latest = row
        }
      }
    }
    if (latest === undefined) {
      continue
    }
    for (const [name, value] of Object.entries(latest.params)) {
      if (!Object.hasOwn(rule.defaults, name)) {
        return err('unknown_parameter')
      }
      const expected = jsonType(rule.defaults[name])
      if (expected !== 'null' && jsonType(value) !== expected) {
        return err('invalid_parameter')
      }
      params[name] = value
    }
  }
  return ok(params)
}
