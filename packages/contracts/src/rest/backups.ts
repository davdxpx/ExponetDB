import * as z from 'zod'
import {
  BackupIdSchema,
  BackupPolicyIdSchema,
  BackupRepositoryIdSchema,
  ClusterIdSchema,
  DrillIdSchema,
  EngineRunIdSchema,
  NodeIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  RestoreIdSchema,
  ServerIdSchema,
  TargetIdSchema,
  TimestampSchema,
  untrustedText,
} from '../common.ts'

/*
 * Wave 9 Part B: backup repositories, policies, the catalog mirror, engine
 * runs, restores and drills (ADR-0036, ADR-0037, ADR-0038;
 * 09-backups-and-restore/). Requests are closed. No response carries a key,
 * a passphrase, a storage credential, a connection string or a full host
 * path: repositories name a secrets reference only as "present" and the
 * scratch directory of a restore only by its run id (C-20, C-21). Values
 * the engine or the host reports are untrusted text (C-26). Every observed
 * state carries its source and time (C-28); a value that cannot be
 * computed is null with a reason, never a guess (C-30).
 */

// ----- repositories -----

export const BACKUP_LAYERS = ['l1_physical', 'l2_logical', 'l3_offprovider'] as const
export const BackupLayerSchema = z.enum(BACKUP_LAYERS).meta({
  id: 'BackupLayer',
  description:
    'l1_physical: base backups and continuous WAL (pgBackRest); l2_logical: pg_dump per database and the globals; l3_offprovider: an encrypted copy on another storage provider (restic).',
})

export const BACKUP_ENGINES = ['pgbackrest', 'pg_dump', 'restic'] as const
export const BackupEngineSchema = z.enum(BACKUP_ENGINES).meta({ id: 'BackupEngine' })

/** Storage providers grow additively; a value never changes its meaning. */
export const STORAGE_PROVIDERS = [
  'hetzner_object_storage',
  'cloudflare_r2',
  's3_compatible',
  'posix',
] as const
export const StorageProviderSchema = z.enum(STORAGE_PROVIDERS).meta({
  id: 'StorageProvider',
  'x-extensible-enum': STORAGE_PROVIDERS,
  description:
    'A label only: no lock or durability property is ever derived from it (ADR-0036 §2). posix: a directory on a host, for disposable labs; never counted as off-host.',
})

export const REPOSITORY_OWNERSHIP = [
  'external',
  'adopted_observed',
  'adopted_runs',
  'owned',
] as const
export const RepositoryOwnershipSchema = z.enum(REPOSITORY_OWNERSHIP).meta({
  id: 'RepositoryOwnership',
  description:
    'external: known, not read; adopted_observed: ExponetDB reads the catalog and may restore from it into scratch, never writes; adopted_runs: in addition ExponetDB may start runs with the host configuration (incremental backups without automatic expiry, verifies), never changing configuration, schedules, keys or retention; owned: ExponetDB writes configuration and schedules (refused until its capability exists, ADR-0036 §3).',
})

export const LockModeSchema = z
  .enum(['none', 's3_object_lock', 'r2_bucket_lock', 'unknown'])
  .meta({ id: 'BackupLockMode', description: 'The lock a person declared; not a proof.' })
export const LockCapabilitySchema = z.enum(['unknown', 'unsupported', 'unproven', 'proven']).meta({
  id: 'BackupLockCapability',
  description:
    'proven only after a recorded delete and overwrite attempt with the writer credential failed (ADR-0036 §2); every other value renders as not proven.',
})

export const RepositoryStateSchema = z
  .enum(['registered', 'observing', 'active', 'degraded', 'retired'])
  .meta({ id: 'BackupRepositoryState' })

export const SecretSourceSchema = z.enum(['host_config', 'sealed']).meta({
  id: 'BackupSecretSource',
  description:
    'host_config: the engine reads the keys and credentials the operator provisioned on the host (pgBackRest configuration, or files under /etc/exponetdb-node/repositories/<id>/); ExponetDB never sees them. sealed: delivered by the Control Plane sealed to the node (ns1); not available in this wave and refused.',
})

/** A storage endpoint host: a lowercase DNS name; never an address with a path or credentials. */
export const StorageHostSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/)
  .meta({ description: 'Endpoint host name (no scheme, port, path or user info).' })
const BucketSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
  .meta({ description: 'Bucket name (S3 naming rules).' })
/** A key prefix inside a bucket: path segments without `..`, no leading slash. */
const PrefixSchema = z
  .string()
  .max(256)
  .regex(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/)
  .refine((v) => !v.split('/').some((s) => s === '..' || s === '.'), 'no . or .. segments')
  .meta({ description: 'Key prefix (no leading slash, no . or .. segments).' })
export const StanzaSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/)
  .meta({ description: 'pgBackRest stanza name.' })
const RegionSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)

export const RepositoryLocationSchema = z
  .strictObject({
    endpointHost: StorageHostSchema.nullable().meta({ description: 'null for posix.' }),
    region: RegionSchema.nullable(),
    bucket: BucketSchema.nullable().meta({ description: 'null for posix.' }),
    prefix: PrefixSchema,
    stanza: StanzaSchema.nullable().meta({ description: 'pgBackRest only.' }),
    repoIndex: z.int().min(1).max(4).nullable().meta({ description: 'pgBackRest repoN.' }),
  })
  .meta({ id: 'BackupRepositoryLocation' })

export const EngineAdvisorySchema = z
  .enum(['none', 'below_floor', 'subkey_check_missing', 'unknown'])
  .meta({
    id: 'BackupEngineAdvisory',
    description:
      'below_floor: the observed engine is older than the pinned floor (pgBackRest 2.59.3, ADR-0036 §5); subkey_check_missing: an encrypted stanza that may predate 2.59.3 has no recorded subkey check; unknown: the engine version was not observed.',
  })

export const BackupRepositorySchema = z
  .object({
    id: BackupRepositoryIdSchema,
    clusterId: ClusterIdSchema,
    layer: BackupLayerSchema,
    engine: BackupEngineSchema,
    provider: StorageProviderSchema,
    location: RepositoryLocationSchema.nullable().meta({
      description:
        'Withheld (null) from callers without registry.manage, and never in MCP output; never a credential.',
    }),
    priority: z.int().min(1).max(9),
    purpose: z.enum(['primary', 'secondary', 'offsite']),
    ownership: RepositoryOwnershipSchema,
    secretSource: SecretSourceSchema,
    lock: z.object({
      mode: LockModeSchema,
      capability: LockCapabilitySchema,
      retentionDays: z.int().min(0).max(36500).nullable(),
      provenAt: TimestampSchema.nullable(),
    }),
    encryption: z.object({
      cipher: z.enum(['aes-256-cbc', 'restic', 'none', 'unknown']),
      offlineCopyConfirmedAt: TimestampSchema.nullable().meta({
        description:
          "A person's statement that an offline copy of the key exists (an attestation).",
      }),
    }),
    engineVersion: z.object({
      pinned: untrustedText(32, 'Pinned engine version.').nullable(),
      observed: untrustedText(32, 'Engine version the node reported.').nullable(),
      advisory: EngineAdvisorySchema,
    }),
    state: RepositoryStateSchema,
    revision: z.int().min(1),
    reconciliation: z
      .object({
        outcome: z.enum(['ok', 'partial', 'failed']),
        at: TimestampSchema,
        errorCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
          .nullable(),
      })
      .nullable()
      .meta({ description: 'The last catalog reconciliation; null before the first.' }),
    createdAt: TimestampSchema,
    retiredAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'BackupRepository' })

export const BackupRepositoryListSchema = z
  .object({
    clusterId: ClusterIdSchema,
    repositories: z.array(BackupRepositorySchema).max(64),
    source: z.literal('control_store'),
    observedAt: TimestampSchema,
  })
  .meta({ id: 'BackupRepositoryList' })

export const BackupRepositoryAdoptRequestSchema = z
  .strictObject({
    layer: BackupLayerSchema,
    engine: BackupEngineSchema,
    provider: StorageProviderSchema,
    location: RepositoryLocationSchema,
    priority: z.int().min(1).max(9).default(1),
    purpose: z.enum(['primary', 'secondary', 'offsite']).default('primary'),
    declaredLockMode: LockModeSchema.default('unknown'),
    cipher: z.enum(['aes-256-cbc', 'restic', 'none', 'unknown']).default('unknown'),
    pinnedEngineVersion: z
      .string()
      .regex(/^[0-9]{1,3}\.[0-9]{1,3}(\.[0-9]{1,3})?$/)
      .nullable()
      .default(null),
  })
  .superRefine((v, ctx) => {
    const posix = v.provider === 'posix'
    if (posix !== (v.location.endpointHost === null) || posix !== (v.location.bucket === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'posix has no endpoint host and no bucket; every other provider has both',
      })
    }
    const pgbr = v.engine === 'pgbackrest'
    if (pgbr !== (v.location.stanza !== null) || pgbr !== (v.location.repoIndex !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'stanza and repoIndex are set exactly for pgbackrest',
      })
    }
    const layerEngine: Record<string, readonly string[]> = {
      l1_physical: ['pgbackrest'],
      l2_logical: ['pg_dump', 'restic'],
      l3_offprovider: ['restic', 'pgbackrest'],
    }
    if (!(layerEngine[v.layer] ?? []).includes(v.engine)) {
      ctx.addIssue({
        code: 'custom',
        path: ['engine'],
        message: 'engine does not serve this layer',
      })
    }
  })
  .meta({
    id: 'BackupRepositoryAdoptRequest',
    description:
      'Adopt an existing repository: ExponetDB starts read-only observation (adopted_observed) and changes nothing on the host or in the bucket (ADR-0036 §3).',
  })

export const BackupRepositoryOwnershipRequestSchema = z
  .strictObject({
    to: z.enum(['adopted_runs', 'owned']),
    acknowledge: z.strictObject({
      hostConfigurationUnchanged: z.literal(true).meta({
        description:
          'adopted_runs: the host configuration, schedules, keys and retention stay as they are.',
      }),
    }),
  })
  .meta({ id: 'BackupRepositoryOwnershipRequest' })

export const BackupRepositoryRetireRequestSchema = z
  .strictObject({
    acknowledge: z.strictObject({
      storageKept: z.literal(true).meta({
        description:
          'Nothing in the bucket or on the host is deleted; the record leaves ExponetDB.',
      }),
      noLongerProtectedByExponetdb: z.literal(true),
    }),
    reason: untrustedText(500, 'Why the repository leaves ExponetDB.').optional(),
  })
  .meta({ id: 'BackupRepositoryRetireRequest' })

// ----- policies -----

/** A five-field cron expression of digits, `*`, `,`, `-` and `/` only (UTC). */
export const CronSchema = z
  .string()
  .max(64)
  .regex(/^[0-9*,/-]+( [0-9*,/-]+){4}$/)
  .meta({ description: 'Five-field cron expression in UTC (digits, *, comma, - and / only).' })

export const BackupScheduleSchema = z
  .strictObject({
    kind: z.enum(['full', 'differential', 'incremental', 'logical']),
    repositoryId: BackupRepositoryIdSchema,
    cron: CronSchema,
    enabled: z.boolean(),
  })
  .meta({ id: 'BackupSchedule' })

export const BackupPolicyBodySchema = z
  .strictObject({
    schedules: z.array(BackupScheduleSchema).max(16),
    retention: z.strictObject({
      fullCount: z.int().min(1).max(100).nullable(),
      differentialCount: z.int().min(1).max(100).nullable(),
      logicalDays: z.int().min(1).max(3650).nullable(),
    }),
    archiveTimeoutSeconds: z.int().min(30).max(3600).nullable(),
    objectives: z.strictObject({
      rpoSeconds: z
        .int()
        .min(60)
        .max(7 * 86400)
        .nullable(),
      rtoSeconds: z
        .int()
        .min(300)
        .max(30 * 86400)
        .nullable(),
    }),
    drillCadenceDays: z.int().min(1).max(366),
    sizeFloorPercent: z.int().min(1).max(100).default(50),
  })
  .meta({ id: 'BackupPolicyBody' })

export const BackupPolicySchema = BackupPolicyBodySchema.extend({
  id: BackupPolicyIdSchema,
  clusterId: ClusterIdSchema,
  revision: z.int().min(1),
  state: z.enum(['active', 'superseded']),
  operationId: OperationIdSchema,
  createdAt: TimestampSchema,
}).meta({ id: 'BackupPolicy' })

export const BackupPolicyViewSchema = z
  .object({
    clusterId: ClusterIdSchema,
    policy: BackupPolicySchema.nullable().meta({ description: 'null: no policy was set.' }),
    source: z.literal('control_store'),
    observedAt: TimestampSchema,
  })
  .meta({ id: 'BackupPolicyView' })

// ----- the catalog mirror -----

export const BackupKindSchema = z.enum(['full', 'differential', 'incremental', 'logical'])

/** A backup as the engine's catalog lists it, mirrored with ExponetDB facts (C-32). */
export const BackupEntrySchema = z
  .object({
    id: BackupIdSchema,
    repositoryId: BackupRepositoryIdSchema,
    engineLabel: untrustedText(
      128,
      'The engine label (pgBackRest backup label, restic snapshot id).',
    ),
    kind: BackupKindSchema,
    state: z.enum(['running', 'succeeded', 'failed']),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
    sizeBytes: z.int().min(0).nullable(),
    repositorySizeBytes: z.int().min(0).nullable(),
    lsnStart: z
      .string()
      .regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/)
      .nullable(),
    lsnStop: z
      .string()
      .regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/)
      .nullable(),
    timeline: z.int().min(1).nullable(),
    postgresMajor: z.int().min(9).max(99).nullable(),
    engineVersion: untrustedText(32, 'Engine version that wrote it.').nullable(),
    verification: z.object({
      state: z.enum(['pending', 'passed', 'failed']),
      verifiedAt: TimestampSchema.nullable(),
    }),
    divergence: z.enum(['none', 'missing_in_engine']).meta({
      description:
        'missing_in_engine: the mirror holds it but the latest engine catalog did not list it (finding backup_catalog_divergence); never counted as protection.',
    }),
    firstSeenAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
  })
  .meta({ id: 'BackupEntry' })

export const WalCoverageSchema = z
  .object({
    repositoryId: BackupRepositoryIdSchema,
    timeline: z.int().min(1),
    from: z.object({ lsn: z.string().max(17), at: TimestampSchema.nullable() }),
    to: z.object({ lsn: z.string().max(17), at: TimestampSchema.nullable() }),
    gaps: z.array(z.object({ fromLsn: z.string().max(17), toLsn: z.string().max(17) })).max(64),
    observedAt: TimestampSchema,
  })
  .meta({ id: 'WalCoverage' })

export const ProtectionReasonSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/)
  .meta({
    'x-extensible-enum': [
      'no_repository',
      'repository_unreadable',
      'catalog_stale',
      'no_verified_backup',
      'wal_archive_failing',
      'wal_gap',
      'rpo_above_objective',
      'rpo_unknown',
      'drill_never',
      'drill_overdue',
      'drill_failed',
      'lock_not_proven',
      'offline_key_unconfirmed',
      'engine_advisory',
      'not_off_host',
    ],
  })

export const BackupProtectionSchema = z
  .object({
    state: z.enum(['protected', 'at_risk', 'unprotected', 'unproven', 'unknown']),
    reasons: z.array(ProtectionReasonSchema).max(32).meta({
      description: 'Why the state is not protected (empty only when protected).',
    }),
    rpo: z.object({
      achievableSeconds: z.int().min(0).nullable().meta({
        description:
          'Measured (C-30): now minus the latest archived WAL time of a healthy, reconciled repository, else minus the newest verified off-host backup; null when neither is known.',
      }),
      uncertaintySeconds: z.int().min(0).nullable(),
      basis: z.enum(['wal_archive', 'verified_backup', 'none']),
      objectiveSeconds: z.int().min(0).nullable(),
    }),
    rto: z.object({
      measuredSeconds: z.int().min(0).nullable().meta({
        description: 'From the last passed drill only; failed or aborted drills never count.',
      }),
      drillId: DrillIdSchema.nullable(),
      drillAt: TimestampSchema.nullable(),
      objectiveSeconds: z.int().min(0).nullable(),
    }),
    pitrWindow: z.object({ from: TimestampSchema, to: TimestampSchema }).nullable(),
    lastVerifiedBackupAt: TimestampSchema.nullable(),
    drill: z.object({
      state: z.enum(['passed_in_cadence', 'overdue', 'failed', 'never']),
      lastPassedAt: TimestampSchema.nullable(),
      cadenceDays: z.int().min(1).nullable(),
    }),
  })
  .meta({ id: 'BackupProtection' })

// ----- engine runs -----

export const EngineRunStateSchema = z
  .enum(['starting', 'running', 'succeeded', 'failed', 'canceled', 'lost', 'unknown'])
  .meta({
    id: 'EngineRunState',
    description:
      'lost: the run disappeared without a result (a host reboot); unknown: the node could not be asked. Neither is ever retried automatically for restores, expiry or verification (ADR-0037 §4).',
  })

export const EngineRunSchema = z
  .object({
    id: EngineRunIdSchema,
    clusterId: ClusterIdSchema,
    repositoryId: BackupRepositoryIdSchema.nullable(),
    nodeId: NodeIdSchema,
    purpose: z.enum(['backup', 'verify', 'expire', 'restore', 'discard']),
    state: EngineRunStateSchema,
    operationId: OperationIdSchema,
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
    lastStatusAt: TimestampSchema.nullable(),
    progress: z
      .object({ percent: z.number().min(0).max(100).nullable(), bytes: z.int().min(0).nullable() })
      .nullable(),
    exitCode: z.int().min(-1).max(255).nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .nullable(),
  })
  .meta({ id: 'EngineRun' })

// ----- the catalog read (GET /clusters/{id}/backups) -----

export const BackupRepositorySummarySchema = z
  .object({
    id: BackupRepositoryIdSchema,
    layer: BackupLayerSchema,
    engine: BackupEngineSchema,
    provider: StorageProviderSchema,
    ownership: RepositoryOwnershipSchema,
    state: RepositoryStateSchema,
    lockCapability: LockCapabilitySchema,
    reconciledAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'BackupRepositorySummary', description: 'No location, credential or key.' })

// ----- restores and drills -----

export const RestorePurposeSchema = z.enum(['drill', 'recovery', 'clone']).meta({
  id: 'RestorePurpose',
  description: 'clone is out of scope in V1 and refused (restore.clone-masking is not built).',
})

export const RestoreStateSchema = z
  .enum([
    'planned',
    'preparing',
    'restoring',
    'recovering',
    'verifying',
    'ready',
    'failed',
    'discarded',
    'promoted',
    'needs_attention',
  ])
  .meta({ id: 'RestoreState' })

export const RestoreSourceRequestSchema = z
  .union([
    z.strictObject({ backupId: BackupIdSchema }),
    z.strictObject({ pointInTime: TimestampSchema }),
    z.strictObject({ latest: z.literal(true) }),
  ])
  .meta({ id: 'RestoreSourceRequest' })

export const RestorePlanRequestSchema = z
  .strictObject({
    purpose: z.literal('recovery'),
    repositoryId: BackupRepositoryIdSchema,
    source: RestoreSourceRequestSchema,
    destination: z.strictObject({
      kind: z.literal('new_cluster'),
      nodeId: NodeIdSchema,
    }),
    reason: untrustedText(1000, 'Why the recovery is needed (incident reference).'),
  })
  .meta({
    id: 'RestorePlanRequest',
    description:
      'Plan a recovery of a target into a new cluster directory on a node (never in place, ADR-0038 §3). The switch of the target is a separate critical placement plan. Agents may plan; the plan is denied for them (restore.human-only) and keeps the analysis.',
  })

export const DrillSelectionSchema = z
  .union([
    z.strictObject({ kind: z.literal('latest') }),
    z.strictObject({ kind: z.literal('older') }),
    z.strictObject({ kind: z.literal('pitr_random') }),
    z.strictObject({ kind: z.literal('backup'), backupId: BackupIdSchema }),
    z.strictObject({ kind: z.literal('pitr'), at: TimestampSchema }),
  ])
  .meta({ id: 'DrillSelection' })

export const DrillPlanRequestSchema = z
  .strictObject({
    repositoryId: BackupRepositoryIdSchema,
    selection: DrillSelectionSchema,
    nodeId: NodeIdSchema.optional().meta({
      description: "Default: the cluster's own node; a drill always restores into scratch.",
    }),
  })
  .meta({ id: 'DrillPlanRequest' })

export const RestoreCheckSchema = z
  .object({
    check: z.enum([
      'recovery_target_reached',
      'probe_simple',
      'probe_extended',
      'amcheck',
      'fingerprint',
      'ledger_head',
      'row_counts',
    ]),
    outcome: z.enum(['passed', 'failed', 'not_run', 'error']),
    detail: untrustedText(512, 'Redacted detail.').nullable(),
  })
  .meta({ id: 'RestoreCheck' })

export const RestoreSchema = z
  .object({
    id: RestoreIdSchema,
    clusterId: ClusterIdSchema,
    targetId: TargetIdSchema.nullable(),
    purpose: RestorePurposeSchema,
    state: RestoreStateSchema,
    source: z.object({
      repositoryId: BackupRepositoryIdSchema,
      backupId: BackupIdSchema.nullable(),
      pointInTime: TimestampSchema.nullable(),
      timeline: z.int().min(1).nullable(),
      walFrom: z.string().max(17).nullable(),
      walTo: z.string().max(17).nullable(),
    }),
    destination: z.object({
      kind: z.enum(['scratch', 'new_cluster']),
      nodeId: NodeIdSchema,
      runId: EngineRunIdSchema.nullable().meta({
        description:
          'The scratch directory is named by the run, chosen by the node; its path is never shown.',
      }),
      port: z.int().min(1024).max(65535).nullable(),
    }),
    phases: z
      .array(
        z.object({
          name: z.enum(['prepare', 'restore', 'recover', 'verify', 'discard']),
          startedAt: TimestampSchema.nullable(),
          finishedAt: TimestampSchema.nullable(),
          outcome: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
        }),
      )
      .max(8),
    checks: z.array(RestoreCheckSchema).max(16),
    planId: PlanIdSchema,
    operationId: OperationIdSchema.nullable(),
    createdAt: TimestampSchema,
    finishedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'Restore' })

export const DrillSchema = z
  .object({
    id: DrillIdSchema,
    clusterId: ClusterIdSchema,
    restoreId: RestoreIdSchema.nullable(),
    repositoryId: BackupRepositoryIdSchema,
    selection: z.enum(['latest', 'older', 'pitr_random', 'backup', 'pitr']),
    mode: z.enum(['control_plane', 'offline_runbook']).meta({
      description:
        'offline_runbook: a person ran the generated runbook with the Control Plane stopped (C-35) and recorded the result afterwards: an attestation, labeled as such.',
    }),
    outcome: z.enum(['pending', 'passed', 'failed', 'aborted', 'attested']),
    measuredRtoSeconds: z.int().min(0).nullable(),
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
  })
  .meta({ id: 'Drill' })

export const OfflineDrillRecordRequestSchema = z
  .strictObject({
    repositoryId: BackupRepositoryIdSchema,
    runbookDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    restoredAt: TimestampSchema,
    durationSeconds: z
      .int()
      .min(1)
      .max(30 * 86400),
    outcome: z.enum(['passed', 'failed']),
    notes: untrustedText(4000, 'What was run, where, and what was checked (no secrets).'),
  })
  .meta({ id: 'OfflineDrillRecordRequest' })

// ----- lists -----

const listOf = <T extends z.ZodType>(id: string, item: T, key: string) =>
  z
    .object({
      clusterId: ClusterIdSchema,
      [key]: z.array(item).max(200),
      nextCursor: z.string().max(512).nullable(),
      source: z.literal('control_store'),
      observedAt: TimestampSchema,
    })
    .meta({ id })

export const RestoreListSchema = listOf('RestoreList', RestoreSchema, 'restores')
export const DrillListSchema = listOf('DrillList', DrillSchema, 'drills')
export const EngineRunListSchema = listOf('EngineRunList', EngineRunSchema, 'runs')

/** One cluster's protection, for the fleet's backups page and the overview slot. */
export const BackupOverviewItemSchema = z
  .object({
    clusterId: ClusterIdSchema,
    serverId: ServerIdSchema.nullable(),
    displayName: untrustedText(128, 'Cluster display name.'),
    managementMode: z.enum(['agent', 'external']),
    repositories: z.int().min(0),
    protection: BackupProtectionSchema,
  })
  .meta({ id: 'BackupOverviewItem' })

export const BackupOverviewSchema = z
  .object({
    clusters: z.array(BackupOverviewItemSchema).max(200),
    counts: z.object({
      protected: z.int().min(0),
      atRisk: z.int().min(0),
      unprotected: z.int().min(0),
      unproven: z.int().min(0),
      unknown: z.int().min(0),
    }),
    nextCursor: z.string().max(512).nullable(),
    source: z.literal('inferred'),
    observedAt: TimestampSchema,
  })
  .meta({
    id: 'BackupOverview',
    description:
      'Protection per cluster computed from the catalog mirror; counts cover every cluster the caller may read, the list is a page.',
  })

/**
 * The backup engine's dependencies of a server or a cluster, for retirement
 * (registry.md §4.4, the UI/UX session's port): what binds it and why. A
 * provider that cannot tell answers `unknown`, which blocks. Names are never
 * bucket names, prefixes or keys: only ExponetDB ids and states.
 */
export const BackupDependencySchema = z
  .object({
    kind: z.enum([
      'repository',
      'policy',
      'engine_run',
      'restore',
      'drill',
      'lock_retention',
      'wal_chain',
      'unreadable',
    ]),
    id: z.string().max(64).nullable(),
    state: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  })
  .meta({ id: 'BackupDependency' })

export type BackupRepositoryAdoptRequest = z.infer<typeof BackupRepositoryAdoptRequestSchema>
export type BackupPolicyBody = z.infer<typeof BackupPolicyBodySchema>
export type RestorePlanRequest = z.infer<typeof RestorePlanRequestSchema>
export type DrillPlanRequest = z.infer<typeof DrillPlanRequestSchema>
export type BackupProtection = z.infer<typeof BackupProtectionSchema>
export type BackupDependency = z.infer<typeof BackupDependencySchema>

/** The generated offline runbook (ADR-0038 §6): plain POSIX shell with placeholders, no secret. */
export const RestoreRunbookSchema = z
  .object({
    clusterId: ClusterIdSchema,
    repositoryId: BackupRepositoryIdSchema,
    repositoryRevision: z.int().min(1),
    filename: z.string().regex(/^exponetdb-restore-[a-z0-9_-]{1,80}\.sh$/),
    digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .meta({
        description:
          'sha256 of the script bytes; the same record revision always gives the same script.',
      }),
    script: z.string().max(65536).meta({
      description:
        'The runbook. It names engine, version, endpoint, bucket, prefix, stanza and repository index of the record, and reads every secret from files the operator supplies from the offline material.',
    }),
    placeholders: z
      .array(
        z.object({
          name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
          meaning: z.string().max(256),
        }),
      )
      .max(16),
    generatedAt: TimestampSchema,
  })
  .meta({ id: 'RestoreRunbook' })

export type BackupRepository = z.infer<typeof BackupRepositorySchema>
export type BackupEntry = z.infer<typeof BackupEntrySchema>
export type WalCoverage = z.infer<typeof WalCoverageSchema>
export type EngineRun = z.infer<typeof EngineRunSchema>
export type Restore = z.infer<typeof RestoreSchema>
export type Drill = z.infer<typeof DrillSchema>
export type BackupOverview = z.infer<typeof BackupOverviewSchema>
export type BackupRepositoryOwnershipRequest = z.infer<
  typeof BackupRepositoryOwnershipRequestSchema
>
export type BackupRepositoryRetireRequest = z.infer<typeof BackupRepositoryRetireRequestSchema>
export type OfflineDrillRecordRequest = z.infer<typeof OfflineDrillRecordRequestSchema>
export type RestoreRunbook = z.infer<typeof RestoreRunbookSchema>
export type BackupRepositoryList = z.infer<typeof BackupRepositoryListSchema>
export type BackupPolicyView = z.infer<typeof BackupPolicyViewSchema>
export type EngineRunList = z.infer<typeof EngineRunListSchema>
export type RestoreList = z.infer<typeof RestoreListSchema>
export type DrillList = z.infer<typeof DrillListSchema>

/** The body of `POST /clusters/{clusterId}/backup-runs`. */
export const BackupRunRequestSchema = z.strictObject({
  repositoryId: BackupRepositoryIdSchema,
  kind: z.enum(['full', 'differential', 'incremental', 'logical']),
})
export type BackupRunRequest = z.infer<typeof BackupRunRequestSchema>
