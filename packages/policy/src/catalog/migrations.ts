import { isJsonArray, isJsonObject, type JsonValue } from '@exponetdb/kernel'
import type { Rule, RuleEvaluation } from '../rules.ts'

/**
 * Migration rules of Wave 6 ([policy-engine.md §4](../../../../exponetdb-docs/02-control-plane/policy-engine.md),
 * "Migrations"; [staging-production-policy.md](../../../../exponetdb-docs/04-migrations/staging-production-policy.md)).
 *
 * They read `content.facts` of a `migration.apply` plan: what the planner
 * established from the stored bundles, the target and the evidence target,
 * live (C-11). A missing or malformed fact is `unknown`, which denies or
 * requires what failing requires. Structural refusals (identity, checksum
 * mismatch, missing or cyclic dependencies, ledger divergence, a stale
 * plan) are refusals of the planner and the kind, never rules a break-glass
 * grant could override (G6 order §35).
 *
 * There is no evidence bypass (C-15): a production target without an
 * evidence target has no evidence, and only a human-only break-glass grant
 * naming `migration.staging-evidence` lets such a plan proceed.
 */
export const MIGRATION_KINDS = ['migration.apply'] as const
/** Kinds that run reviewed bundle SQL on a target (apply, an explicit rollback, a resume). */
export const SQL_KINDS = ['migration.apply', 'migration.rollback', 'migration.resume'] as const
/** Kinds that run statements outside a transaction. */
export const AUTOCOMMIT_KINDS = ['migration.apply', 'migration.resume'] as const
/** Kinds whose verify.sql may run declared consumer code. */
export const VERIFYING_KINDS = ['migration.apply', 'migration.verify'] as const
/**
 * Kinds that read or change a production target with bundle SQL: the SQL
 * kinds and a verification run again, whose verify.sql (stored by the
 * caller, outside the apply checksum) answers a question about the data.
 */
export const AGENT_PRODUCTION_KINDS = [...SQL_KINDS, 'migration.verify'] as const

export type EvidenceFact =
  | 'present'
  | 'missing'
  | 'unverified'
  | 'other_verify_digest'
  | 'unreachable'
  | 'not_required'

export type LineageFact = 'match' | 'mismatch' | 'unknown' | 'not_required'

/** `content.facts` of a `migration.apply` plan. */
export interface MigrationFacts {
  readonly compatibility: string
  readonly lockSeverity: string
  readonly nontransactional: boolean
  readonly blockingFindings: number
  readonly consumerCode: number
  readonly requirementsUnmet: readonly string[]
  readonly evidence: EvidenceFact
  readonly lineage: LineageFact
  readonly dependenciesVerified: boolean
  readonly legacyProject: boolean
  /** Execution roles of the plan that run under a declared BYPASSRLS exception (ADR-0034; Wave 9). */
  readonly executionRoleExceptions?: number
  /** Production: the evidence environment's execution roles compared with production's (ADR-0034 §4). */
  readonly executionRoleParity?: 'match' | 'mismatch' | 'unknown' | 'not_required'
  /**
   * Whether the SQL the plan runs is procedural (OD-55 (c)): `DO` blocks,
   * procedure calls, functions a top-level `SELECT` calls, routines or
   * triggers the bundle creates, dynamic SQL where the text shows it; a
   * statement list that is not known counts as procedural.
   */
  readonly procedural?: boolean
  /** Why, as fixed codes (`do_block`, `call`, `function_call`, `routine_created`, …). */
  readonly proceduralReasons?: readonly string[]
}

const EVIDENCE = new Set([
  'present',
  'missing',
  'unverified',
  'other_verify_digest',
  'unreachable',
  'not_required',
])
const LINEAGE = new Set(['match', 'mismatch', 'unknown', 'not_required'])

export function migrationFacts(content: JsonValue | undefined): MigrationFacts | undefined {
  const facts = isJsonObject(content) ? content['facts'] : undefined
  if (!isJsonObject(facts)) return undefined
  const f = facts
  if (
    typeof f['compatibility'] !== 'string' ||
    typeof f['lockSeverity'] !== 'string' ||
    typeof f['nontransactional'] !== 'boolean' ||
    typeof f['blockingFindings'] !== 'number' ||
    typeof f['consumerCode'] !== 'number' ||
    !isJsonArray(f['requirementsUnmet']) ||
    !f['requirementsUnmet'].every((r) => typeof r === 'string') ||
    typeof f['evidence'] !== 'string' ||
    !EVIDENCE.has(f['evidence']) ||
    typeof f['lineage'] !== 'string' ||
    !LINEAGE.has(f['lineage']) ||
    typeof f['dependenciesVerified'] !== 'boolean' ||
    typeof f['legacyProject'] !== 'boolean'
  ) {
    return undefined
  }
  return {
    compatibility: f['compatibility'],
    lockSeverity: f['lockSeverity'],
    nontransactional: f['nontransactional'],
    blockingFindings: f['blockingFindings'],
    consumerCode: f['consumerCode'],
    requirementsUnmet: f['requirementsUnmet'] as string[],
    evidence: f['evidence'] as EvidenceFact,
    lineage: f['lineage'] as LineageFact,
    dependenciesVerified: f['dependenciesVerified'],
    legacyProject: f['legacyProject'],
  }
}

const UNKNOWN: RuleEvaluation = {
  result: 'unknown',
  message: 'The plan carries no readable migration facts.',
}

function approvals(params: Readonly<Record<string, JsonValue>>, extra: 'reauth' | null = null) {
  const count = params['approvals']
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 10) {
    return []
  }
  const within = params['reauthWithinSeconds']
  const reauth =
    extra === 'reauth' &&
    typeof within === 'number' &&
    Number.isSafeInteger(within) &&
    within >= 1 &&
    within <= 900
      ? [{ kind: 'reauth' as const, withinSeconds: within }]
      : []
  if (extra === 'reauth' && reauth.length === 0) return []
  return [{ kind: 'approval' as const, count, permission: 'plans.approve' as const }, ...reauth]
}

function prodOnly(
  tier: 'prod' | 'nonprod' | undefined,
  evaluate: () => RuleEvaluation,
): RuleEvaluation {
  if (tier === 'nonprod') {
    return { result: 'not_applicable', message: 'The target is not production.' }
  }
  if (tier === undefined) {
    return { result: 'unknown', message: 'The tier of the target is not known.' }
  }
  return evaluate()
}

export const migrationLintErrors: Rule = {
  id: 'migration.lint-errors',
  version: 1,
  description: 'Blocking lint findings and refused verify.sql checks deny the plan.',
  appliesTo: SQL_KINDS,
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const f = migrationFacts(request.content)
    if (f === undefined) return UNKNOWN
    return f.blockingFindings === 0
      ? { result: 'pass', message: 'No blocking finding.' }
      : {
          result: 'fail',
          message: 'The bundles have blocking findings.',
          facts: { blockingFindings: f.blockingFindings },
          remediation: 'Fix the findings shown in the plan and plan again.',
        }
  },
}

function requirementRule(
  id: string,
  requirement: string,
  description: string,
  message: string,
  kinds: readonly string[] = MIGRATION_KINDS,
): Rule {
  return {
    id,
    version: 1,
    description,
    appliesTo: kinds,
    severity: 'deny',
    overridableByBreakGlass: false,
    facts: [],
    defaults: {},
    requirements: () => [],
    evaluate({ request }) {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      return f.requirementsUnmet.includes(requirement)
        ? { result: 'fail', message, facts: { requirement } }
        : { result: 'pass', message: 'Met.' }
    },
  }
}

export const migrationPgVersion = requirementRule(
  'migration.pg-version',
  'postgres',
  'requires.postgres is satisfied by the target server version.',
  'The target server version does not satisfy requires.postgres.',
)

export const migrationExtensions = requirementRule(
  'migration.extensions',
  'extensions',
  'requires.extensions are installed in the required versions.',
  'A required extension is missing or has another version; install it with a node operation first.',
)

export const migrationExecutionRole = requirementRule(
  'migration.execution-role',
  'execution_role',
  'Every execution role alias maps to a usable NOLOGIN owner the migrator may SET ROLE into.',
  'An execution role is not mapped in the registry or not usable (NOLOGIN, SET-only membership, nothing protected reachable).',
  SQL_KINDS,
)

export const migrationStagingEvidence: Rule = {
  id: 'migration.staging-evidence',
  version: 1,
  description:
    'Production applies a checksum only after it was applied and verified on the configured evidence target (C-15); no evidence override exists.',
  appliesTo: MIGRATION_KINDS,
  severity: 'deny',
  overridableByBreakGlass: true,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      if (f.evidence === 'present' || f.evidence === 'other_verify_digest') {
        return {
          result: 'pass',
          message: 'The evidence target applied and verified this checksum.',
        }
      }
      return {
        result: f.evidence === 'unreachable' ? 'unknown' : 'fail',
        message:
          f.evidence === 'unreachable'
            ? 'The evidence target could not be read; evidence is not assumed.'
            : 'The evidence target has not applied and verified this checksum.',
        facts: { evidence: f.evidence },
        remediation: 'Apply and verify the same bundles on the evidence target first.',
      }
    })
  },
}

export const migrationStagingVerifyDigest: Rule = {
  id: 'migration.staging-verify-digest',
  version: 1,
  description: 'The evidence target verified with the same verify.sql digest production will use.',
  appliesTo: MIGRATION_KINDS,
  severity: 'require',
  overridableByBreakGlass: true,
  facts: [],
  defaults: {},
  requirements: () => [{ kind: 'break_glass', rules: ['migration.staging-verify-digest'] }],
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      return f.evidence === 'other_verify_digest'
        ? {
            result: 'fail',
            message: 'The evidence target verified another verify.sql.',
            remediation: 'Run migration.verify on the evidence target with this revision.',
          }
        : { result: 'pass', message: 'Same verify digest.' }
    })
  },
}

export const migrationDependenciesVerified: Rule = {
  id: 'migration.dependencies-verified',
  // Version 2 (Part A follow-up 4): the target's baseline counts as a dependency of every plan.
  version: 2,
  description:
    "Dependencies, and the target's baseline of an imported history, are verified on the production target, not only applied.",
  appliesTo: MIGRATION_KINDS,
  severity: 'require',
  overridableByBreakGlass: true,
  facts: [],
  defaults: {},
  requirements: () => [{ kind: 'break_glass', rules: ['migration.dependencies-verified'] }],
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      return f.dependenciesVerified
        ? { result: 'pass', message: 'Every applied dependency passed its verification.' }
        : {
            result: 'fail',
            message:
              "An applied dependency, or the target's baseline, has no passing verification on this target.",
            remediation:
              'Run migration.verify for the dependency, or for the baseline (baseline:<slug>), first.',
          }
    })
  },
}

export const migrationFingerprintLineage: Rule = {
  id: 'migration.fingerprint-lineage',
  version: 1,
  description:
    "Production's current fingerprint equals the evidence target's fingerprint before the migration (OD-14 (a)); a mismatch needs an approval.",
  appliesTo: MIGRATION_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements: (params) => approvals(params),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      if (f.legacyProject || f.lineage === 'match' || f.lineage === 'not_required') {
        return { result: 'not_applicable', message: 'Lineage matches or is shown as a warning.' }
      }
      return {
        result: f.lineage === 'unknown' ? 'unknown' : 'fail',
        message:
          f.lineage === 'unknown'
            ? 'No fingerprint of the evidence target before this migration is known to compare with.'
            : 'Production and the evidence target diverged before this migration.',
        facts: { lineage: f.lineage },
      }
    })
  },
}

export const migrationFingerprintLineageLegacy: Rule = {
  id: 'migration.fingerprint-lineage-legacy',
  version: 1,
  description:
    'For an imported legacy project, a lineage mismatch is shown as a warning until it is reconciled (OD-14 (a)).',
  appliesTo: MIGRATION_KINDS,
  severity: 'warn',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      if (!f.legacyProject || f.lineage === 'match' || f.lineage === 'not_required') {
        return { result: 'not_applicable', message: 'Not a legacy lineage difference.' }
      }
      return {
        result: 'fail',
        message: 'Production and the evidence target diverged (imported legacy history).',
        facts: { lineage: f.lineage },
      }
    })
  },
}

const NON_ADDITIVE = new Set(['potentially_breaking', 'data_rewrite', 'destructive', 'unknown'])

export const migrationCompatibility: Rule = {
  id: 'migration.compatibility',
  version: 1,
  description:
    'A production migration that is not additive needs a human approval (with the compatibility attestation of the running build).',
  appliesTo: MIGRATION_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements: (params) => approvals(params),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      return NON_ADDITIVE.has(f.compatibility)
        ? {
            result: 'fail',
            message: `The observed compatibility class is ${f.compatibility}.`,
            facts: { compatibility: f.compatibility },
          }
        : { result: 'pass', message: 'Additive.' }
    })
  },
}

export const migrationDestructiveBackup: Rule = {
  id: 'migration.destructive-backup',
  version: 1,
  description:
    'A destructive, data-rewriting or unclassified production migration needs a verified backup newer than 24 hours (Wave 9); until then it is blocked or needs break-glass.',
  appliesTo: SQL_KINDS,
  severity: 'require',
  overridableByBreakGlass: true,
  facts: [],
  defaults: {},
  requirements: () => [{ kind: 'backup', newerThan: 'PT24H', verified: true }],
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      return ['destructive', 'data_rewrite', 'unknown'].includes(f.compatibility)
        ? {
            result: 'fail',
            message: 'A verified recent backup is required before this change.',
            facts: { compatibility: f.compatibility },
          }
        : { result: 'not_applicable', message: 'Not destructive.' }
    })
  },
}

export const migrationLockRisk: Rule = {
  id: 'migration.lock-risk',
  version: 1,
  description: 'A production migration with a high or unknown lock severity needs an approval.',
  appliesTo: SQL_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements: (params) => approvals(params),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      return f.lockSeverity === 'high' ||
        f.lockSeverity === 'critical' ||
        f.lockSeverity === 'unknown'
        ? {
            result: 'fail',
            message: `Lock severity ${f.lockSeverity}.`,
            facts: { lock: f.lockSeverity },
          }
        : { result: 'pass', message: 'Lock severity below high.' }
    })
  },
}

export const migrationNontransactional: Rule = {
  id: 'migration.nontransactional',
  version: 1,
  description:
    'A non-transactional production migration (or its resume) needs an approval and a fresh re-authentication.',
  appliesTo: AUTOCOMMIT_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: (params) => approvals(params, 'reauth'),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const f = migrationFacts(request.content)
      if (f === undefined) return UNKNOWN
      return f.nontransactional
        ? { result: 'fail', message: 'Statements run outside a transaction.' }
        : { result: 'not_applicable', message: 'Transactional.' }
    })
  },
}

export const migrationAgentProduction: Rule = {
  id: 'migration.agent-production',
  // 2 (Wave 7): also a verification run again (`migration.verify`).
  version: 2,
  description:
    'A production migration or verification run an AI agent client initiates needs a human approval (OD-9: the human may approve the plan the agent proposed).',
  appliesTo: AGENT_PRODUCTION_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements: (params) => approvals(params),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () =>
      request.principal.client === 'mcp' || request.principal.kind !== 'human'
        ? {
            result: 'fail',
            message: 'Not initiated by a person through a first-party client.',
            facts: { client: request.principal.client, kind: request.principal.kind },
          }
        : { result: 'pass', message: 'A person initiated it.' },
    )
  },
}

export const migrationVerifyConsumerCode: Rule = {
  id: 'migration.verify-consumer-code',
  version: 1,
  description:
    'verify.sql checks that call a consumer function or read a consumer view need an explicit approval on every tier.',
  appliesTo: VERIFYING_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements: (params) => approvals(params),
  evaluate({ request }) {
    const f = migrationFacts(request.content)
    if (f === undefined) return UNKNOWN
    return f.consumerCode > 0
      ? {
          result: 'fail',
          message: 'verify.sql runs declared consumer code; a person accepts it by approving.',
          facts: { consumerCode: f.consumerCode },
        }
      : { result: 'not_applicable', message: 'No consumer code.' }
  },
}

export const migrationRollbackProduction: Rule = {
  id: 'migration.rollback-production',
  version: 1,
  description:
    'Running down.sql on production needs a human approval and a fresh re-authentication (an explicit rollback plan, never automatic).',
  appliesTo: ['migration.rollback'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: (params) => approvals(params, 'reauth'),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => ({
      result: 'fail',
      message: 'A production rollback runs only after a human approval.',
    }))
  },
}

export const migrationBaselineProduction: Rule = {
  id: 'migration.baseline-production',
  version: 1,
  description:
    'Baselining a production target records reviewed legacy history as applied: a human approval and a fresh re-authentication.',
  appliesTo: ['migration.baseline'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: (params) => approvals(params, 'reauth'),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => ({
      result: 'fail',
      message: 'A production baseline is recorded only after a human approval.',
    }))
  },
}

/**
 * `migration.ledger-reconcile-production` (TC-007, MIG-03): `ledger.reconcile` adopts the target's
 * ledger as the truth (ledger.md §5), after a restore or a hand change, and so unblocks schema
 * plans on a ledger ExponetDB did not write. It reads only the tier the planner resolved (the
 * plan carries no migration facts): on production, a human approval and a fresh re-authentication;
 * an unknown tier requires the same, and no break-glass grant overrides it.
 */
export const migrationLedgerReconcileProduction: Rule = {
  id: 'migration.ledger-reconcile-production',
  version: 1,
  description:
    'Adopting a production target ledger as the truth (after a restore or a hand change) needs a human approval and a fresh re-authentication.',
  appliesTo: ['ledger.reconcile'],
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1, reauthWithinSeconds: 300 },
  requirements: (params) => approvals(params, 'reauth'),
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => ({
      result: 'fail',
      message: 'A production ledger is adopted as the truth only after a human approval.',
    }))
  },
}

/** The execution role facts a legacy replay plan binds (`content.executionRoleCheck`). */
function replayRoleCheck(
  content: JsonValue | undefined,
): { readonly role: string; readonly problem: string | null } | undefined {
  const check = isJsonObject(content) ? content['executionRoleCheck'] : undefined
  if (!isJsonObject(check) || typeof check['role'] !== 'string') return undefined
  const problem = check['problem']
  if (problem !== null && typeof problem !== 'string') return undefined
  return { role: check['role'], problem }
}

export const migrationImportExecutionRole: Rule = {
  id: 'migration.import-execution-role',
  version: 1,
  description:
    'A legacy replay runs as an execution role the migrator may SET ROLE into, checked like an apply (Wave 9 order A3); no override.',
  appliesTo: ['migration.import.replay'],
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const check = replayRoleCheck(request.content)
    if (check === undefined) {
      return { result: 'unknown', message: 'The plan carries no execution role check.' }
    }
    return check.problem === null || check.problem === 'declared_exception'
      ? { result: 'pass', message: 'The execution role is usable on the scratch target.' }
      : {
          result: 'fail',
          message: `The execution role is not usable on the scratch target: ${check.problem}.`,
          facts: { role: check.role, problem: check.problem },
          remediation:
            'Map the alias to a NOLOGIN owner without privileged attributes and grant it to exponetdb_migrator WITH INHERIT FALSE, SET TRUE.',
        }
  },
}

/** Kinds that run SQL as an execution role (ADR-0034): the SQL kinds and the legacy replay. */
const EXECUTION_ROLE_KINDS = [...SQL_KINDS, 'migration.import.replay'] as const

export const migrationExecutionRoleException: Rule = {
  id: 'migration.execution-role-exception',
  version: 1,
  description:
    'A plan whose execution role carries BYPASSRLS under a declared exception (ADR-0034) shows it in every plan; it never blocks by itself.',
  appliesTo: EXECUTION_ROLE_KINDS,
  severity: 'warn',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const content = request.content
    const facts = isJsonObject(content) ? content['facts'] : undefined
    const count = isJsonObject(facts) ? facts['executionRoleExceptions'] : undefined
    const replay = replayRoleCheck(content)
    const used =
      (typeof count === 'number' && count > 0) || replay?.problem === 'declared_exception'
    return used
      ? {
          result: 'fail',
          message:
            'The execution role runs with BYPASSRLS under a declared exception: row security does not apply to what the migration reads.',
          facts: { roles: typeof count === 'number' ? count : 1 },
          remediation:
            'Move SECURITY DEFINER functions to a dedicated definer role so the execution role can drop BYPASSRLS, then revoke the exception.',
        }
      : { result: 'not_applicable', message: 'No declared exception is used.' }
  },
}

export const migrationExecutionRoleParity: Rule = {
  id: 'migration.execution-role-parity',
  version: 1,
  description:
    "Production: the evidence environment's execution roles have the attributes and the exception status of production's (ADR-0034 §4); a warning otherwise.",
  appliesTo: MIGRATION_KINDS,
  severity: 'warn',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    return prodOnly(request.subject.tier, () => {
      const content = request.content
      const facts = isJsonObject(content) ? content['facts'] : undefined
      const parity = isJsonObject(facts) ? facts['executionRoleParity'] : undefined
      if (parity === 'match' || parity === 'not_required') {
        return { result: 'pass', message: 'The evidence ran under equal execution roles.' }
      }
      return {
        result: 'fail',
        message:
          parity === 'mismatch'
            ? "The evidence environment's execution roles differ in attributes or exception status: its verification proves less about production."
            : 'Whether the evidence ran under equal execution roles is not known.',
        facts: { parity: typeof parity === 'string' ? parity : 'unknown' },
      }
    })
  },
}

/** Kinds an agent can plan whose SQL may be procedural: the SQL kinds and the legacy replay. */
const PROCEDURAL_KINDS = [...SQL_KINDS, 'migration.import.replay'] as const

/**
 * The procedural classification a plan carries (`content.facts.procedural`):
 * `true` or `false`, or `unclassified` when the plan carries none or a
 * malformed one, which counts as procedural (OD-55 (c): fail closed).
 */
function proceduralOf(content: JsonValue | undefined): {
  readonly procedural: boolean | 'unclassified'
  readonly reasons: readonly string[]
} {
  const facts = isJsonObject(content) ? content['facts'] : undefined
  const value = isJsonObject(facts) ? facts['procedural'] : undefined
  const reasons = isJsonObject(facts) ? facts['proceduralReasons'] : undefined
  const list =
    isJsonArray(reasons) && reasons.every((r) => typeof r === 'string')
      ? (reasons as string[]).slice(0, 8)
      : []
  return typeof value === 'boolean'
    ? { procedural: value, reasons: list }
    : { procedural: 'unclassified', reasons: ['unclassified'] }
}

export const migrationAgentProcedural: Rule = {
  id: 'migration.agent-procedural',
  version: 1,
  description:
    'A migration plan an AI agent client initiates whose SQL is procedural (DO blocks, called or created routines, triggers, dynamic SQL; unclassified counts as procedural) needs a human approval on every tier (OD-55 (c)).',
  appliesTo: PROCEDURAL_KINDS,
  severity: 'require',
  overridableByBreakGlass: false,
  facts: [],
  defaults: { approvals: 1 },
  requirements: (params) => approvals(params),
  evaluate({ request }) {
    const p = request.principal
    if (p.kind === 'human' && (p.client === 'web' || p.client === 'cli')) {
      return { result: 'not_applicable', message: 'A person initiated it.' }
    }
    const { procedural, reasons } = proceduralOf(request.content)
    return procedural === false
      ? { result: 'pass', message: 'No procedural statement.' }
      : {
          result: 'fail',
          message:
            procedural === true
              ? 'The SQL is procedural: code it runs can act as any role the migrator holds; a person approves it.'
              : 'The plan carries no procedural classification; it counts as procedural.',
          facts: { client: p.client, kind: p.kind, reasons: [...reasons] },
          remediation: 'Ask a person to review and approve the plan.',
        }
  },
}

export const migrationProceduralNontransactional: Rule = {
  id: 'migration.procedural-nontransactional',
  version: 1,
  description:
    'Procedural SQL in a non-transactional bundle is refused for every principal: its statements commit one by one, so the ledger guard cannot roll back what they do (OD-55 (d)).',
  appliesTo: AUTOCOMMIT_KINDS,
  severity: 'deny',
  overridableByBreakGlass: false,
  facts: [],
  defaults: {},
  requirements: () => [],
  evaluate({ request }) {
    const f = migrationFacts(request.content)
    if (f === undefined) return UNKNOWN
    if (!f.nontransactional) {
      return { result: 'not_applicable', message: 'Transactional: the ledger guard applies.' }
    }
    const { procedural, reasons } = proceduralOf(request.content)
    return procedural === false
      ? { result: 'pass', message: 'No procedural statement.' }
      : {
          result: 'fail',
          message:
            'A non-transactional bundle runs procedural SQL the ledger guard cannot roll back.',
          facts: { reasons: [...reasons] },
          remediation:
            'Move the procedural statements into a transactional bundle; keep only the statement that needs autocommit here.',
        }
  },
}

export const MIGRATION_RULES: readonly Rule[] = [
  migrationLintErrors,
  migrationPgVersion,
  migrationExtensions,
  migrationExecutionRole,
  migrationStagingEvidence,
  migrationStagingVerifyDigest,
  migrationDependenciesVerified,
  migrationFingerprintLineage,
  migrationFingerprintLineageLegacy,
  migrationCompatibility,
  migrationDestructiveBackup,
  migrationLockRisk,
  migrationNontransactional,
  migrationAgentProduction,
  migrationVerifyConsumerCode,
  migrationRollbackProduction,
  migrationBaselineProduction,
  migrationLedgerReconcileProduction,
  migrationImportExecutionRole,
  migrationExecutionRoleException,
  migrationExecutionRoleParity,
  migrationAgentProcedural,
  migrationProceduralNontransactional,
]
