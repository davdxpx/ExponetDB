import type { Rule } from '../rules.ts'

/**
 * Registry rules of Wave 4 ([policy-engine.md §4](../../../../exponetdb-docs/02-control-plane/policy-engine.md),
 * "Registry and drift"). They read only the request's subject tier, which
 * the registry resolved from the environment when it planned; an unknown
 * tier is `unknown` and therefore requires what production requires.
 */
export const targetRegisterProdApproval: Rule = {
  id: 'target.register-prod-approval',
  version: 1,
  description:
    'Registering a production target (identity marker and ledger) needs a human approval and a fresh re-authentication.',
  appliesTo: ['target.register'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements(params) {
    const count = params['approvals']
    const within = params['reauthWithinSeconds']
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      typeof within !== 'number' ||
      !Number.isSafeInteger(within) ||
      within < 1 ||
      within > 900
    ) {
      return []
    }
    return [
      { kind: 'approval', count, permission: 'plans.approve' },
      { kind: 'reauth', withinSeconds: within },
    ]
  },
  evaluate({ request }) {
    const tier = request.subject.tier
    if (tier === 'nonprod') {
      return { result: 'not_applicable', message: 'The target is not production.' }
    }
    if (tier === 'prod') {
      return {
        result: 'fail',
        message: 'A production target is registered only after a human approval.',
        facts: { tier },
      }
    }
    return { result: 'unknown', message: 'The tier of the target is not known.' }
  },
}

/**
 * `drift.accept-prod` (Wave 8): accepting drift on a production target
 * turns an unreviewed change into the schema future plans bind to
 * (drift-detection.md §5), so it needs a human approval and a fresh
 * re-authentication. It reads the subject tier the planner resolved from
 * the target; an unknown tier requires the same. The reason that
 * security-relevant drift also needs is checked by the planner (a request
 * without one is refused before a plan exists).
 */
export const driftAcceptProd: Rule = {
  id: 'drift.accept-prod',
  version: 1,
  description:
    'Accepting drift on a production target (its current schema becomes the expected one) needs a human approval and a fresh re-authentication.',
  appliesTo: ['drift.accept'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: targetRegisterProdApproval.requirements,
  evaluate({ request }) {
    const tier = request.subject.tier
    if (tier === 'nonprod') {
      return { result: 'not_applicable', message: 'The target is not production.' }
    }
    if (tier === 'prod') {
      return {
        result: 'fail',
        message: 'Drift on a production target is accepted only after a human approval.',
        facts: { tier },
      }
    }
    return { result: 'unknown', message: 'The tier of the target is not known.' }
  },
}

/**
 * `registry.execution-role-exception-production` (Wave 9, ADR-0034 §2, OD-51):
 * declaring or revoking a `BYPASSRLS` execution-role exception for a
 * production environment needs a human approval and a fresh
 * re-authentication. The subject tier is the environment's, resolved by the
 * planner; an unknown tier requires the same.
 */
export const executionRoleExceptionProduction: Rule = {
  id: 'registry.execution-role-exception-production',
  version: 1,
  description:
    'Declaring or revoking a BYPASSRLS execution-role exception for a production environment needs a human approval and a fresh re-authentication.',
  appliesTo: [
    'registry.execution_role_exception.declare',
    'registry.execution_role_exception.revoke',
  ],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: targetRegisterProdApproval.requirements,
  evaluate({ request }) {
    const tier = request.subject.tier
    if (tier === 'nonprod') {
      return { result: 'not_applicable', message: 'The environment is not production.' }
    }
    if (tier === 'prod') {
      return {
        result: 'fail',
        message: 'A production execution-role exception changes only after a human approval.',
        facts: { tier },
      }
    }
    return { result: 'unknown', message: 'The tier of the environment is not known.' }
  },
}

export const REGISTRY_RULES: readonly Rule[] = [
  targetRegisterProdApproval,
  driftAcceptProd,
  executionRoleExceptionProduction,
]
