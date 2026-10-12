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
  version: 1,
  description: 'Dependencies are verified on the production target, not only applied.',
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
            message: 'An applied dependency has no passing verification on this target.',
            remediation: 'Run migration.verify for the dependency first.',
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
  version: 1,
  description:
    'A production migration an AI agent client initiates needs a human approval (OD-9: the human may approve the plan the agent proposed).',
  appliesTo: SQL_KINDS,
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
]
