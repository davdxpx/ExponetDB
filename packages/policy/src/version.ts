import {
  canonicalize,
  encodeUtf8,
  err,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  ok,
  type Result,
} from '@exponetdb/kernel'
import { sha256HexOf } from '@exponetdb/kernel/hash'

/**
 * The policy version `pv1` ([policy-engine.md §5.1](../../../exponetdb-docs/02-control-plane/policy-engine.md#51-policy-version-pv1)):
 * which rule code and which effective configuration produced a decision.
 *
 *   input = UTF8("exponetdb/policy-version/pv1") LF
 *         + frame("code",   UTF8(codeVersion))
 *         + frame("rules",  UTF8(JCS(rules sorted by id)))
 *         + frame("config", UTF8(JCS(config)))
 *   frame(label, b) = UTF8(label) LF decimal(len(b)) LF b LF
 *   policyVersion = "sha256:pv1:" + lowercase hex(SHA-256(input))
 *
 * `codeVersion` is the server build (`<package version>+<commit>`); `rules`
 * lists `{id, version}` of every rule that applied to the request; `config`
 * has exactly one object member per listed rule (its effective parameters).
 * A stored value (plans, approvals, audit); a change is `pv2`.
 */
export const PV1_DOMAIN = 'exponetdb/policy-version/pv1'
export const POLICY_VERSION = /^sha256:pv1:[0-9a-f]{64}$/
export const RULE_ID = /^[a-z][a-z0-9_]*(?:\.[a-z0-9-]+)+$/
const CODE_VERSION = /^[0-9A-Za-z.+-]{1,128}$/

export interface RuleVersion {
  readonly id: string
  readonly version: number
}

export type PolicyVersionRefusal =
  | 'invalid_code_version'
  | 'invalid_rule'
  | 'duplicate_rule'
  | 'config_mismatch'

function isRuleVersion(value: unknown): value is RuleVersion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value).sort()
  const id: unknown = Reflect.get(value, 'id')
  const version: unknown = Reflect.get(value, 'version')
  return (
    keys.length === 2 &&
    keys[0] === 'id' &&
    keys[1] === 'version' &&
    typeof id === 'string' &&
    id.length <= 128 &&
    RULE_ID.test(id) &&
    typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version >= 1
  )
}

function frame(label: string, text: string): Uint8Array[] {
  const bytes = encodeUtf8(text)
  return [encodeUtf8(`${label}\n${bytes.length}\n`), bytes, encodeUtf8('\n')]
}

export function policyVersion(
  codeVersion: string,
  rules: readonly unknown[],
  config: JsonValue,
): Result<string, PolicyVersionRefusal> {
  if (!CODE_VERSION.test(codeVersion)) {
    return err('invalid_code_version')
  }
  const checked: RuleVersion[] = []
  for (const rule of rules) {
    if (!isRuleVersion(rule)) {
      return err('invalid_rule')
    }
    checked.push({ id: rule.id, version: rule.version })
  }
  const ids = new Set(checked.map((r) => r.id))
  if (ids.size !== checked.length) {
    return err('duplicate_rule')
  }
  if (!isJsonObject(config)) {
    return err('config_mismatch')
  }
  const members = Object.keys(config)
  if (members.length !== ids.size || members.some((m) => !ids.has(m) || !isJsonObject(config[m]))) {
    return err('config_mismatch')
  }
  const sorted = [...checked].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const rulesText = canonicalize(sorted.map((r) => ({ id: r.id, version: r.version })))
  const configText = canonicalize(config)
  if (!rulesText.ok || !configText.ok) {
    return err('config_mismatch')
  }
  const hash = sha256HexOf([
    encodeUtf8(`${PV1_DOMAIN}\n`),
    ...frame('code', codeVersion),
    ...frame('rules', rulesText.value),
    ...frame('config', configText.value),
  ])
  return ok(`sha256:pv1:${hash}`)
}

export type EffectiveConfig = Readonly<Record<string, JsonObject>>
