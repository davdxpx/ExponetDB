import { isJsonObject } from '@exponetdb/kernel'
import type { Rule, RuleEvaluation, RuleInput } from '../rules.ts'

/**
 * Connection rules of Wave 9 Part B ([policy-engine.md §4](../../../../exponetdb-docs/02-control-plane/policy-engine.md),
 * "Connections"; performance.md §5). They read the session facts the
 * planner recorded in the plan's content (`content.session`, read live by
 * pid on the target): `protected` names why ExponetDB never signals the
 * session (`not_client_backend`, `backup_session`, `exponetdb_session`,
 * `superuser_session`) or is `null`. The signaling statement re-checks the
 * same predicate, so a session that became protected after planning is not
 * signaled either. Missing or malformed facts are `unknown` (fail closed).
 */
export const CONNECTION_KINDS = ['connections.cancel', 'connections.terminate'] as const

type Protection = { readonly found: boolean; readonly protected: string | null } | undefined

function protectionOf(input: RuleInput): Protection {
  const content = input.request.content
  const session = isJsonObject(content) ? content['session'] : undefined
  if (!isJsonObject(session) || typeof session['found'] !== 'boolean') return undefined
  const p = session['protected']
  if (p !== null && typeof p !== 'string') return undefined
  return { found: session['found'], protected: p }
}

const UNKNOWN: RuleEvaluation = {
  result: 'unknown',
  message: 'The session facts of the plan are missing.',
}

/** Replication, background and backup sessions are never cancelled or terminated. */
export const connectionsReplicationProtect: Rule = {
  id: 'connections.replication-protect',
  version: 1,
  description:
    'Never cancel or terminate a replication (walsender), background or backup session (pgBackRest, pg_basebackup, pg_dump and similar).',
  appliesTo: CONNECTION_KINDS,
  severity: 'deny',
  overridableByBreakGlass: true,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate(input) {
    const p = protectionOf(input)
    if (p === undefined) return UNKNOWN
    if (!p.found)
      return { result: 'not_applicable', message: 'No such session (the plan is stale).' }
    return p.protected === 'not_client_backend' || p.protected === 'backup_session'
      ? {
          result: 'fail',
          message: 'The session is a replication, background or backup session.',
          facts: { protected: p.protected },
          remediation: 'Stop the job at its source (the backup tool, the replica) instead.',
        }
      : { result: 'pass', message: 'A client session that is not a backup.' }
  },
}

/** Superuser sessions and ExponetDB's own sessions are never signaled (not overridable). */
export const connectionsNoSuperuserTerminate: Rule = {
  id: 'connections.no-superuser-terminate',
  version: 1,
  description:
    "Never cancel or terminate a superuser's session or one of ExponetDB's own (its roles, its application names).",
  appliesTo: CONNECTION_KINDS,
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate(input) {
    const p = protectionOf(input)
    if (p === undefined) return UNKNOWN
    if (!p.found)
      return { result: 'not_applicable', message: 'No such session (the plan is stale).' }
    return p.protected === 'superuser_session' || p.protected === 'exponetdb_session'
      ? {
          result: 'fail',
          message: "The session is a superuser's or ExponetDB's own.",
          facts: { protected: p.protected },
        }
      : { result: 'pass', message: "Neither a superuser's nor ExponetDB's session." }
  },
}

/**
 * Terminating a backend on production from an agent client (not a person
 * through the Web App or the first-party CLI) needs a human approval; a
 * person proceeds. An unknown tier counts as production.
 */
export const connectionsProdTerminateApproval: Rule = {
  id: 'connections.prod-terminate-approval',
  version: 1,
  description:
    'Terminating a backend on a production target needs a human approval when an agent client planned it.',
  appliesTo: ['connections.terminate'],
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
    if (!agent) return { result: 'not_applicable', message: 'A person plans the termination.' }
    const tier = request.subject.tier
    if (tier === 'nonprod') {
      return { result: 'not_applicable', message: 'The target is not production.' }
    }
    if (tier === 'prod') {
      return {
        result: 'fail',
        message: "An agent's production termination waits for a person.",
        facts: { tier, client: p.client, kind: p.kind },
      }
    }
    return { result: 'unknown', message: 'The tier of the target is not known.' }
  },
}

export const CONNECTION_RULES: readonly Rule[] = [
  connectionsNoSuperuserTerminate,
  connectionsProdTerminateApproval,
  connectionsReplicationProtect,
]
