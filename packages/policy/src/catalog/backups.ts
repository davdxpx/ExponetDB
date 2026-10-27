import { isJsonObject, type JsonObject, type JsonValue } from '@exponetdb/kernel'
import type { Rule } from '../rules.ts'
import { targetRegisterProdApproval } from './registry.ts'

/**
 * Backup and restore rules of Wave 9 Part B ([policy-engine.md §4](../../../../exponetdb-docs/02-control-plane/policy-engine.md),
 * "Backups and restore"; ADR-0036 to ADR-0038). They read only the
 * request's subject tier, its principal and its content, which the planner
 * resolved from the Control Store; a missing member is `unknown` and an
 * unknown tier requires what production requires. None of them can be
 * overridden by break-glass.
 */

/** Changes of a cluster's backup records (repository adoption, ownership, retirement, policy). */
export const BACKUP_CHANGE_KINDS = [
  'backup.repository.adopt',
  'backup.repository.ownership',
  'backup.repository.retire',
  'backup.policy.set',
] as const

/** Kinds that restore into scratch or a new cluster, or discard one. */
export const RESTORE_KINDS = ['restore.execute', 'restore.drill', 'restore.discard'] as const

function content(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function member(o: JsonObject | undefined, ...path: readonly string[]): JsonValue | undefined {
  let cur: JsonValue | undefined = o
  for (const key of path) {
    if (!isJsonObject(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

/** A production cluster's backup records change only after a human approval and a fresh re-authentication. */
export const backupChangeProdApproval: Rule = {
  id: 'backup.change-prod-approval',
  version: 1,
  description:
    "Adopting, changing or retiring a production cluster's backup repository, or setting its backup policy, needs a human approval and a fresh re-authentication.",
  appliesTo: BACKUP_CHANGE_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: targetRegisterProdApproval.requirements,
  evaluate({ request }) {
    const tier = request.subject.tier
    if (tier === 'nonprod') {
      return { result: 'not_applicable', message: 'The cluster is not production.' }
    }
    if (tier === 'prod') {
      return {
        result: 'fail',
        message: "A production cluster's backup records change only after a human approval.",
        facts: { tier },
      }
    }
    return { result: 'unknown', message: 'The tier of the cluster is not known.' }
  },
}

/**
 * `restore.human-only` (restore.md §8): a restore, a drill and a discard are
 * executed by a person in a Web App or CLI session only. An agent's plan is
 * stored with decision `deny` and keeps its analysis; a person re-plans it.
 */
export const restoreHumanOnly: Rule = {
  id: 'restore.human-only',
  version: 1,
  description:
    'Restores, drills and discards are executed by a person (Web App or CLI); an agent may only plan them, and its plan is denied.',
  appliesTo: RESTORE_KINDS,
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const p = request.principal
    if (p.kind === 'human' && (p.client === 'web' || p.client === 'cli')) {
      return { result: 'pass', message: 'A person plans the restore.' }
    }
    return {
      result: 'fail',
      message:
        'Only a person executes a restore; this plan keeps its analysis for a person to re-plan.',
      facts: { principalKind: p.kind, client: p.client },
      remediation: 'A person re-plans the same restore in the Web App or the CLI and applies it.',
    }
  },
}

/** A recovery restore (critical) always needs a human approval and a fresh re-authentication. */
export const restoreRecoveryApproval: Rule = {
  id: 'restore.recovery-approval',
  version: 1,
  description:
    'A recovery restore needs a human approval and a fresh re-authentication, on every tier.',
  appliesTo: ['restore.execute'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: targetRegisterProdApproval.requirements,
  evaluate() {
    return { result: 'fail', message: 'A recovery restore is approved by a person before it runs.' }
  },
}

/**
 * `restore.source-verified`: the source backup passed its verification and
 * the WAL range is continuous on its timeline, as the planner read them;
 * the kind checks both again at apply.
 */
export const restoreSourceVerified: Rule = {
  id: 'restore.source-verified',
  version: 1,
  description:
    'A restore starts only from a backup whose verification passed and a WAL range that is continuous on its timeline.',
  appliesTo: ['restore.execute', 'restore.drill'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const c = content(request.content)
    const verification = member(c, 'source', 'verification')
    const continuous = member(c, 'source', 'walContinuous')
    if (verification === undefined || continuous === undefined) {
      return { result: 'unknown', message: 'The plan does not say how its source was verified.' }
    }
    if (verification !== 'passed') {
      return {
        result: 'fail',
        message: 'The source backup has no passed verification.',
        facts: { verification },
        remediation: 'Verify the backup first (POST /clusters/{id}/backups/{backupId}/verify).',
      }
    }
    if (continuous !== true) {
      return {
        result: 'fail',
        message: 'The WAL range to the requested point is not shown to be continuous.',
        facts: { walContinuous: continuous },
      }
    }
    return { result: 'pass', message: 'The source is verified and its WAL range continuous.' }
  },
}

/**
 * `restore.target-identity` (T19): a drill restores into scratch only, a
 * recovery into a new cluster only, never in place; the node and its
 * cluster identity are bound in the plan.
 */
export const restoreTargetIdentity: Rule = {
  id: 'restore.target-identity',
  version: 1,
  description:
    'A drill restores into scratch and a recovery into a new cluster on a bound node; never over a running or registered cluster.',
  appliesTo: ['restore.execute', 'restore.drill'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const c = content(request.content)
    const kind = member(c, 'destination', 'kind')
    const node = member(c, 'destination', 'nodeId')
    const system = member(c, 'source', 'systemIdentifier')
    if (typeof kind !== 'string' || typeof node !== 'string' || typeof system !== 'string') {
      return { result: 'unknown', message: 'The plan does not bind its destination.' }
    }
    const expected = request.kind === 'restore.drill' ? 'scratch' : 'new_cluster'
    if (kind !== expected) {
      return {
        result: 'fail',
        message: `This restore must go into ${expected}, never in place.`,
        facts: { destination: kind },
      }
    }
    return { result: 'pass', message: 'The destination is a new, bound location.' }
  },
}

/** `restore.clone-masking`: clones are out of scope in V1 (no masking profile exists). */
export const restoreCloneRefused: Rule = {
  id: 'restore.clone-masking',
  version: 1,
  description:
    'Clones of a cluster into another target are not built in V1 (no masking profile); refused.',
  appliesTo: ['restore.execute'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const purpose = member(content(request.content), 'purpose')
    if (purpose === 'clone') {
      return { result: 'fail', message: 'Clones are not available in V1.' }
    }
    return { result: 'not_applicable', message: 'Not a clone.' }
  },
}

/**
 * `backup.repository-runs-allowed`: a backup run uses a repository whose
 * ownership allows runs (adopted_runs: incremental only; owned: all), as
 * the planner read it; the node checks its own host mode file as well.
 */
export const backupRunsAllowed: Rule = {
  id: 'backup.repository-runs-allowed',
  version: 1,
  description:
    'A backup run needs a repository that allows runs: adopted_runs for incremental backups only, owned for every kind.',
  appliesTo: ['backup.run'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const c = content(request.content)
    const ownership = member(c, 'repository', 'ownership')
    const kind = member(c, 'kind')
    if (typeof ownership !== 'string' || typeof kind !== 'string') {
      return { result: 'unknown', message: 'The plan does not name the repository ownership.' }
    }
    if (ownership === 'owned') {
      return { result: 'pass', message: 'ExponetDB owns the repository.' }
    }
    if (ownership === 'adopted_runs' && kind === 'incremental') {
      return {
        result: 'pass',
        message: 'An incremental backup into an adopted repository that allows runs.',
      }
    }
    return {
      result: 'fail',
      message:
        ownership === 'adopted_runs'
          ? 'An adopted repository takes only incremental backups from ExponetDB (a full or differential backup would shorten the host retention).'
          : 'This repository does not allow runs by ExponetDB.',
      facts: { ownership, kind },
    }
  },
}

/** Production backup runs of an agent need a human approval (OD-13 spirit for consequential agent actions). */
export const backupRunAgentProd: Rule = {
  id: 'backup.run-agent-prod-approval',
  version: 1,
  description:
    "An agent's backup run or verification on a production cluster needs a human approval.",
  appliesTo: ['backup.run'],
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
    const p = request.principal
    const agent = !(p.kind === 'human' && (p.client === 'web' || p.client === 'cli'))
    if (!agent) return { result: 'not_applicable', message: 'A person plans the run.' }
    const tier = request.subject.tier
    if (tier === 'nonprod')
      return { result: 'not_applicable', message: 'The cluster is not production.' }
    if (tier === 'prod') {
      return {
        result: 'fail',
        message: "An agent's production backup run waits for a person.",
        facts: { tier },
      }
    }
    return { result: 'unknown', message: 'The tier of the cluster is not known.' }
  },
}

export const BACKUP_RULES: readonly Rule[] = [
  backupChangeProdApproval,
  restoreHumanOnly,
  restoreRecoveryApproval,
  restoreSourceVerified,
  restoreTargetIdentity,
  restoreCloneRefused,
  backupRunsAllowed,
  backupRunAgentProd,
]
