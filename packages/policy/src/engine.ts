import {
  type Clock,
  canonicalize,
  formatTimestamp,
  InvariantError,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  toJsonValue,
} from '@exponetdb/kernel'
import { resolveParams, type SettingRow } from './config.ts'
import type { Fact, FactName, FactProvider } from './facts.ts'
import type { Decision, PolicyDecision, PolicyRequest, Requirement, RuleResult } from './model.ts'
import type { Rule, RuleRegistry } from './rules.ts'
import { policyVersion } from './version.ts'

/**
 * Evaluation and combination ([policy-engine.md §3](../../../exponetdb-docs/02-control-plane/policy-engine.md#3-decision-model)).
 *
 * - Rules run in rule id order; the decision never depends on the order in
 *   which facts arrive.
 * - `unknown` counts as `fail` at the rule's severity (C-11): a missing fact
 *   provider, a provider error, an invalid configuration, a rule that throws
 *   or returns a malformed result are all `unknown`.
 * - Any blocking `deny` → `deny`; else any blocking `require` → `require`
 *   with the union of requirements; else `allow`. `warn` never blocks.
 * - A break-glass grant overrides exactly the rules it names that are
 *   overridable, and only for a human actor through a non-agent client. An
 *   override is never silent: the decision requires the grant
 *   (`break_glass` requirement) and lists the overridden rules. There is no
 *   other override and no force flag.
 */
export interface PolicyEngineOptions {
  readonly registry: RuleRegistry
  readonly providers: readonly FactProvider[]
  /** `<package version>+<commit>` of the running build. */
  readonly codeVersion: string
  readonly clock: Clock
}

export interface Evaluation {
  readonly request: PolicyRequest
  readonly settings: readonly SettingRow[]
}

const RANK: Readonly<Record<Decision, number>> = { allow: 0, require: 1, deny: 2 }

export function decisionRank(decision: Decision): number {
  return RANK[decision]
}

function requirementKey(requirement: Requirement): string {
  const json = toJsonValue(requirement)
  const text = json.ok ? canonicalize(json.value) : undefined
  if (text === undefined || !text.ok) {
    throw new InvariantError('policy requirements are JSON')
  }
  return text.value
}

/** Deduplicated, in canonical order: equal inputs give equal lists. */
export function unionRequirements(lists: readonly (readonly Requirement[])[]): Requirement[] {
  const byKey = new Map<string, Requirement>()
  for (const list of lists) {
    for (const r of list) {
      byKey.set(requirementKey(r), r)
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r)
}

export function sameRequirement(a: Requirement, b: Requirement): boolean {
  return requirementKey(a) === requirementKey(b)
}

function breakGlassHonored(request: PolicyRequest): readonly string[] {
  const grant = request.breakGlass
  if (grant === undefined) {
    return []
  }
  if (request.principal.kind !== 'human' || request.principal.client === 'mcp') {
    return []
  }
  return grant.rules
}

async function loadFacts(
  rules: readonly Rule[],
  providers: readonly FactProvider[],
  request: PolicyRequest,
): Promise<Map<FactName, Fact>> {
  const needed = [...new Set(rules.flatMap((r) => r.facts))].sort()
  const loaded = await Promise.all(
    needed.map(async (name): Promise<[FactName, Fact]> => {
      const provider = providers.find((p) => p.name === name)
      if (provider === undefined) {
        return [name, { status: 'unknown', reason: 'provider_missing' }]
      }
      try {
        const fact = await provider.load(request)
        if (fact.status === 'known' && !toJsonValue(fact.value).ok) {
          return [name, { status: 'unknown', reason: 'provider_invalid' }]
        }
        return [name, fact]
      } catch {
        return [name, { status: 'unknown', reason: 'provider_failed' }]
      }
    }),
  )
  return new Map(loaded)
}

function result(
  rule: Rule,
  params: JsonObject,
  outcome: RuleResult['result'],
  message: string,
  facts: JsonObject,
  remediation?: string,
): RuleResult {
  return {
    id: rule.id,
    version: rule.version,
    result: outcome,
    severity: rule.severity,
    message,
    facts,
    ...(remediation === undefined ? {} : { remediation }),
    overridableByBreakGlass: rule.overridableByBreakGlass,
    requirements: rule.severity === 'require' ? requirementsOf(rule, params) : [],
  }
}

/** A rule whose requirements cannot be computed requires nothing that could be met: it denies (see below). */
function requirementsOf(rule: Rule, params: JsonObject): readonly Requirement[] {
  try {
    return rule.requirements(params)
  } catch {
    return []
  }
}

function evaluateRule(
  rule: Rule,
  params: JsonObject,
  request: PolicyRequest,
  facts: Map<FactName, Fact>,
): RuleResult {
  const unknownFacts = rule.facts.filter((name) => facts.get(name)?.status !== 'known').sort()
  if (unknownFacts.length > 0) {
    return result(rule, params, 'unknown', 'A fact this rule needs is not available.', {
      unknownFacts,
    })
  }
  const known: { -readonly [N in FactName]?: JsonValue } = {}
  for (const name of rule.facts) {
    const fact = facts.get(name)
    if (fact?.status === 'known') {
      known[name] = fact.value
    }
  }
  let evaluation: ReturnType<Rule['evaluate']>
  try {
    evaluation = rule.evaluate({ request, facts: known, params })
  } catch {
    return result(rule, params, 'unknown', 'The rule could not be evaluated.', {
      error: 'rule_failed',
    })
  }
  const factsJson = evaluation.facts === undefined ? {} : evaluation.facts
  if (
    !['pass', 'fail', 'not_applicable', 'unknown'].includes(evaluation.result) ||
    typeof evaluation.message !== 'string' ||
    evaluation.message.length > 1024 ||
    !isJsonObject(factsJson) ||
    !toJsonValue(factsJson).ok ||
    (evaluation.remediation !== undefined &&
      (typeof evaluation.remediation !== 'string' || evaluation.remediation.length > 1024))
  ) {
    return result(rule, params, 'unknown', 'The rule returned an invalid result.', {
      error: 'rule_result_invalid',
    })
  }
  return result(
    rule,
    params,
    evaluation.result,
    evaluation.message,
    factsJson,
    evaluation.remediation,
  )
}

export class PolicyEngine {
  readonly #options: PolicyEngineOptions

  constructor(options: PolicyEngineOptions) {
    if (!policyVersion(options.codeVersion, [], {}).ok) {
      throw new InvariantError('the policy engine needs a valid code version')
    }
    this.#options = options
  }

  async evaluate(evaluation: Evaluation): Promise<PolicyDecision> {
    const { request, settings } = evaluation
    const rules = this.#options.registry.rulesFor(request.kind)
    const facts = await loadFacts(rules, this.#options.providers, request)
    const config: Record<string, JsonObject> = {}
    const results: RuleResult[] = []
    for (const rule of rules) {
      const params = resolveParams(rule, settings, request.subject)
      if (!params.ok) {
        config[rule.id] = {}
        results.push(
          result(rule, rule.defaults, 'unknown', 'The rule configuration is not valid.', {
            configError: params.error,
          }),
        )
        continue
      }
      config[rule.id] = params.value
      results.push(evaluateRule(rule, params.value, request, facts))
    }

    const named = new Set(breakGlassHonored(request))
    const overridden = results
      .filter(
        (r) =>
          (r.result === 'fail' || r.result === 'unknown') &&
          r.overridableByBreakGlass &&
          named.has(r.id),
      )
      .map((r) => r.id)
      .sort()
    const blocking = results.filter(
      (r) =>
        (r.result === 'fail' || r.result === 'unknown') &&
        r.severity !== 'warn' &&
        !overridden.includes(r.id),
    )
    let decision: Decision
    let requirements: Requirement[]
    // A blocking `require` result without requirements cannot be satisfied:
    // it denies rather than allowing by omission (fail closed).
    if (
      blocking.some(
        (r) => r.severity === 'deny' || (r.severity === 'require' && r.requirements.length === 0),
      )
    ) {
      decision = 'deny'
      requirements = []
    } else {
      const lists = blocking.filter((r) => r.severity === 'require').map((r) => r.requirements)
      if (overridden.length > 0) {
        lists.push([{ kind: 'break_glass', rules: overridden }])
      }
      requirements = unionRequirements(lists)
      decision = requirements.length > 0 ? 'require' : 'allow'
    }

    const version = policyVersion(
      this.#options.codeVersion,
      rules.map((r) => ({ id: r.id, version: r.version })),
      config,
    )
    if (!version.ok) {
      throw new InvariantError('policy version inputs are produced by the engine itself')
    }
    return {
      decision,
      requirements,
      rules: results,
      overriddenRules: overridden,
      policyVersion: version.value,
      evaluatedAt: formatTimestamp(this.#options.clock.nowMs()),
    }
  }
}
