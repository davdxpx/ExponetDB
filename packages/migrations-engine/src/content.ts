import { MigrationPlanContentSchema } from '@exponetdb/contracts'
import type { PlanRecord } from '@exponetdb/operations'
import type { MigrationFacts } from '@exponetdb/policy'
import type { ConsumerCode } from '@exponetdb/postgres'

/**
 * The stored content of a `migration.apply` plan as the engine builds and
 * reads it (the wire shape is `MigrationPlanContent` in the contracts; the
 * engine works with plain strings and validates the stored body against
 * that schema before it acts on it).
 */
export interface PlanItem {
  readonly migrationId: string
  readonly name: string
  readonly revision: number
  readonly checksum: string
  readonly verifyDigest: string | null
  readonly rollbackDigest: string | null
  readonly sourceDigest: string
  readonly bundleDigest: string
  readonly transactional: boolean
  readonly executionRole: string
  readonly searchPath: readonly string[]
  readonly lockTimeoutMs: number
  readonly statementTimeoutMs: number
  readonly dependsOn: readonly string[]
  readonly source: Readonly<Record<string, string>> | null
  readonly verifyChecks: number
  readonly consumerCode: readonly ConsumerCode[]
}

export interface PlanContent {
  readonly projectId: string
  readonly migrations: readonly PlanItem[]
  readonly execution: {
    readonly mode: 'transactional' | 'nontransactional'
    readonly lockWaitSeconds: number
    readonly stopOnVerificationFailure: true
  }
  readonly target: {
    readonly targetId: string
    readonly path: string
    readonly tier: 'prod' | 'nonprod'
    readonly generation: number
    readonly clusterSystemIdentifier: string
    readonly databaseOid: string
    readonly serverVersionNum: number
  }
  readonly expectedState: {
    readonly schemaFingerprint: string
    readonly ledgerStateHash: string
    readonly extensions: Readonly<Record<string, string>>
    readonly executionRoles: Readonly<Record<string, string>>
  }
  readonly evidence: {
    readonly targetId: string
    readonly generation: number
    readonly verifications: Readonly<Record<string, string>>
  } | null
  readonly facts: MigrationFacts
}

export class PlanContentInvalid extends Error {
  override readonly name = 'PlanContentInvalid'
}

/** The plan's content, checked against the wire schema (a body that does not parse is stale content). */
export function planContent(plan: Pick<PlanRecord, 'body'>): PlanContent {
  const parsed = MigrationPlanContentSchema.safeParse(plan.body['content'])
  if (!parsed.success) {
    throw new PlanContentInvalid('the stored migration plan content does not match its schema')
  }
  return parsed.data as unknown as PlanContent
}
