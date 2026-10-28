import type { Rule } from '../rules.ts'

/**
 * Node and cluster rules of Wave 5 ([policy-engine.md §4](../../../../exponetdb-docs/02-control-plane/policy-engine.md),
 * "Node and cluster"; Wave 5 correction F2).
 */

/**
 * The operation kinds that change a host or a cluster through the node
 * agent: every apply of the Wave 5 catalog and, since Wave 8, setting a
 * role's verifier. The node lifecycle kinds
 * (`node.enroll`, `node.revoke`, `node.decommission`) change the registry's
 * trust in a node, not the host, and stay human-only with re-authentication
 * (policy-engine.md §4); `node.inspect` reads.
 */
export const NODE_APPLY_KINDS = [
  'credential.rotate',
  'node.config.update',
  'postgres.config.apply',
  'postgres.extensions.apply',
  'postgres.hba.apply',
  'postgres.reload',
  'postgres.restart',
  'postgres.roles.apply',
  'postgres.roles.verifier.set',
  'postgres.tls.rotate',
] as const

/**
 * Every change through the node agent on a production cluster or node needs
 * a human approval, whatever its class: `high`, `critical` and a
 * re-authentication are no substitute. The tier is the one the planner
 * derived from the affected cluster or server; an unknown tier is `unknown`
 * and therefore requires what production requires.
 */
export const nodeProdApplyApproval: Rule = {
  id: 'node.prod-apply-approval',
  // Version 2 (Wave 8, owner decision S3): also postgres.roles.verifier.set.
  version: 2,
  description:
    'A change through the node agent on a production cluster or node needs a human approval.',
  appliesTo: NODE_APPLY_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements(params) {
    const count = params['approvals']
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 10) {
      return []
    }
    return [{ kind: 'approval', count, permission: 'plans.approve' }]
  },
  evaluate({ request }) {
    const tier = request.subject.tier
    if (tier === 'nonprod') {
      return { result: 'not_applicable', message: 'The cluster or node is not production.' }
    }
    if (tier === 'prod') {
      return {
        result: 'fail',
        message: 'A change on a production cluster or node runs only after a human approval.',
        facts: { tier },
      }
    }
    return { result: 'unknown', message: 'The tier of the cluster or node is not known.' }
  },
}

/**
 * `node.lifecycle-reauth` (test campaign TC-019): revoking or decommissioning a node cuts
 * ExponetDB off from a host and is applied only after a fresh re-authentication (the action
 * catalog requires it at apply). The rule lists that requirement in the plan, on every tier, so
 * the person and an agent see it before they apply instead of meeting `REAUTH_REQUIRED`.
 */
export const nodeLifecycleReauth: Rule = {
  id: 'node.lifecycle-reauth',
  version: 1,
  description:
    'Revoking or decommissioning a node needs a fresh re-authentication, which the plan lists.',
  appliesTo: ['node.revoke', 'node.decommission'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { reauthWithinSeconds: 300 },
  requirements(params) {
    const within = params['reauthWithinSeconds']
    if (typeof within !== 'number' || !Number.isSafeInteger(within) || within < 1 || within > 900) {
      return []
    }
    return [{ kind: 'reauth', withinSeconds: within }]
  },
  evaluate() {
    return {
      result: 'fail',
      message: 'Revoking or decommissioning a node runs only after a fresh re-authentication.',
    }
  },
}

export const NODE_RULES: readonly Rule[] = [nodeProdApplyApproval, nodeLifecycleReauth]
