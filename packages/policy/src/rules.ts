import type { JsonObject } from '@exponetdb/kernel'
import type { FactName, Facts } from './facts.ts'
import type { PolicyRequest, Requirement, Severity } from './model.ts'
import { RULE_ID } from './version.ts'

/**
 * A rule: reviewed TypeScript, parameterized by configuration
 * ([policy-engine.md §1](../../../exponetdb-docs/02-control-plane/policy-engine.md#1-why-a-central-policy-engine)).
 * `evaluate` is pure and synchronous: it sees the request, the facts it
 * declared and its effective parameters, nothing else (no I/O, no clock).
 */
export interface RuleEvaluation {
  readonly result: 'pass' | 'fail' | 'not_applicable' | 'unknown'
  readonly message: string
  readonly facts?: JsonObject
  readonly remediation?: string
}

export interface RuleInput {
  readonly request: PolicyRequest
  readonly facts: Facts
  readonly params: JsonObject
}

export interface Rule {
  readonly id: string
  /** Bumped when the rule's semantics change; part of the policy version. */
  readonly version: number
  readonly description: string
  /** Operation kinds the rule applies to: exact kinds or `<domain>.*`. */
  readonly appliesTo: readonly string[]
  readonly severity: Severity
  readonly overridableByBreakGlass: boolean
  /** Fact providers the rule reads; a missing or failed one makes the result `unknown`. */
  readonly facts: readonly FactName[]
  /** Parameters and their defaults; settings may override known members only. */
  readonly defaults: JsonObject
  /** What failing at `require` severity requires (also when the result is `unknown`). */
  requirements(params: JsonObject): readonly Requirement[]
  evaluate(input: RuleInput): RuleEvaluation
}

export type RuleDefinitionError =
  | 'invalid_rule_id'
  | 'invalid_version'
  | 'duplicate_rule'
  | 'invalid_applies_to'
  | 'require_without_requirements'
  | 'requirements_without_require'

const KIND_PATTERN = /^[a-z][a-z0-9_]*(?:\.(?:[a-z][a-z0-9_]*|\*))+$/

export class RuleRegistryError extends Error {
  override readonly name = 'RuleRegistryError'
  readonly code: RuleDefinitionError
  readonly ruleId: string
  constructor(code: RuleDefinitionError, ruleId: string) {
    super(`The policy rule ${ruleId} is not a valid definition (${code}).`)
    this.code = code
    this.ruleId = ruleId
  }
}

function applies(pattern: string, kind: string): boolean {
  return pattern.endsWith('.*') ? kind.startsWith(pattern.slice(0, -1)) : pattern === kind
}

/**
 * The rule registry. Built once at startup by the composition root from the
 * rules of the enabled operation kinds; definitions are checked on
 * registration so that a broken rule fails startup, not a decision.
 */
export class RuleRegistry {
  readonly #rules = new Map<string, Rule>()

  constructor(rules: readonly Rule[] = []) {
    for (const rule of rules) {
      this.register(rule)
    }
  }

  register(rule: Rule): void {
    if (rule.id.length > 128 || !RULE_ID.test(rule.id)) {
      throw new RuleRegistryError('invalid_rule_id', rule.id)
    }
    if (!Number.isSafeInteger(rule.version) || rule.version < 1) {
      throw new RuleRegistryError('invalid_version', rule.id)
    }
    if (this.#rules.has(rule.id)) {
      throw new RuleRegistryError('duplicate_rule', rule.id)
    }
    if (rule.appliesTo.length === 0 || rule.appliesTo.some((p) => !KIND_PATTERN.test(p))) {
      throw new RuleRegistryError('invalid_applies_to', rule.id)
    }
    const requirements = rule.requirements(rule.defaults)
    if (rule.severity === 'require' && requirements.length === 0) {
      throw new RuleRegistryError('require_without_requirements', rule.id)
    }
    if (rule.severity !== 'require' && requirements.length > 0) {
      throw new RuleRegistryError('requirements_without_require', rule.id)
    }
    this.#rules.set(rule.id, rule)
  }

  /** Rules that apply to `kind`, in rule id order (the evaluation order). */
  rulesFor(kind: string): readonly Rule[] {
    return [...this.#rules.values()]
      .filter((r) => r.appliesTo.some((p) => applies(p, kind)))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  get(id: string): Rule | undefined {
    return this.#rules.get(id)
  }

  get size(): number {
    return this.#rules.size
  }
}
