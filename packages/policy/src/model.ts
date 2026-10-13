import type { PolicyDecisionKind, PolicyRequirement } from '@exponetdb/contracts'
import type { JsonObject, JsonValue } from '@exponetdb/kernel'

/**
 * The decision model ([policy-engine.md §3](../../../exponetdb-docs/02-control-plane/policy-engine.md#3-decision-model)).
 */
export type Severity = 'deny' | 'require' | 'warn'
export type RuleOutcome = 'pass' | 'fail' | 'not_applicable' | 'unknown'
export type Requirement = PolicyRequirement
export type Decision = PolicyDecisionKind

/** Who is asking, through which client (facts from authentication, never from the request body). */
export interface Principal {
  readonly kind: 'human' | 'service' | 'system'
  readonly identityId: string | null
  /**
   * `web`, `cli`, `mcp`, `ci`, `rest` or `system`. An agent (OD-13 (a)) is every caller
   * that is not a person through `web` or `cli`; the `principal` fact `agent` says so.
   */
  readonly client: 'web' | 'rest' | 'mcp' | 'cli' | 'ci' | 'system'
  readonly reauthAt?: string
}

/** The scope chain of the subject, most general first; settings at a more specific level win. */
export interface SubjectScope {
  readonly productId?: string
  readonly projectId?: string
  readonly environmentId?: string
  readonly targetId?: string
  readonly tier?: 'prod' | 'nonprod'
}

/** A break-glass grant names the rules it overrides; nothing else is overridden. */
export interface BreakGlass {
  readonly grantId: string
  readonly rules: readonly string[]
}

export interface PolicyRequest {
  /** Operation kind (`<domain>.<verb>`); rules declare which kinds they apply to. */
  readonly kind: string
  readonly principal: Principal
  readonly subject: SubjectScope
  readonly breakGlass?: BreakGlass
  /** Kind-specific, already validated content (never interpreted as policy). */
  readonly content?: JsonValue
}

export interface RuleResult {
  readonly id: string
  readonly version: number
  readonly result: RuleOutcome
  readonly severity: Severity
  /** Human-readable, no secrets. */
  readonly message: string
  /** The inputs used (ids, counts, states); never secret values. */
  readonly facts: JsonObject
  readonly remediation?: string
  readonly overridableByBreakGlass: boolean
  /** Requirements this rule imposes when it fails at `require` severity. */
  readonly requirements: readonly Requirement[]
}

export interface PolicyDecision {
  readonly decision: Decision
  readonly requirements: readonly Requirement[]
  /** Every evaluated rule, in rule id order. */
  readonly rules: readonly RuleResult[]
  readonly overriddenRules: readonly string[]
  readonly policyVersion: string
  readonly evaluatedAt: string
}
