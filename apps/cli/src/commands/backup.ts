import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { BackupProtection, BackupRepository, Drill, RestoreRunbook } from '@exponetdb/sdk'
import { bodyFromFile, checkedBody, FILE_FLAG, planCommand } from '../cli/planning.ts'
import { arg, fieldListCommand, flag, showCommand } from '../cli/reads.ts'
import { must, RemoteFailure } from '../cli/remote.ts'
import type { CommandInput, CommandSpec, FlagSpec } from '../cli/types.ts'
import { UsageError } from '../cli/usage.ts'
import { inlineResult, WAIT_FLAGS } from '../cli/watch.ts'
import { CliError } from '../errors.ts'
import { checkNewPrivateFile, createNewPrivateFile } from '../files.ts'
import { ago, dash, header, toneOf } from '../output/format.ts'
import { type Block, result, type Tone } from '../output/model.ts'
import { clean } from '../output/text.ts'

/**
 * Backups, restores and drills (Wave 9 Part B; ADR-0036 to ADR-0038,
 * [`09-backups-and-restore/`](../../../../exponetdb-docs/09-backups-and-restore/architecture.md)).
 * Reads show the catalog mirror with its source and time and the measured
 * protection (a value the server could not measure reads as unknown, never
 * a guess). Every change is a plan the server makes and decides. A recovery
 * is planned here and applied only with `plan apply` (human, fresh
 * re-authentication in the browser); there is no command that restores
 * directly. No command takes a key, a passphrase or a storage credential:
 * the engine reads them on the host.
 */
const READ = ['backups.read']
const MANAGE = ['registry.manage']
const RUN = ['backups.run']
const RESTORE_PLAN = ['restore.plan']
const RESTORE_EXECUTE = ['restore.execute']

const CLUSTER_ARG = { name: 'cluster', description: 'A cluster id (cls_…).', required: true }
const REPOSITORY_FLAG: FlagSpec = {
  name: 'repository',
  type: 'string',
  placeholder: 'bkr_…',
  description: 'A backup repository id (bkr_…).',
  required: true,
}
const KINDS = ['full', 'differential', 'incremental', 'logical']
const PROTECTION_STATES = ['protected', 'at_risk', 'unprotected', 'unproven', 'unknown']

/** A duration in seconds as a person reads it (`-` when unknown). */
export function seconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return '-'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
}

/** A size in bytes (binary units; `-` when unknown). */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let v = n
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return u === 0 ? `${n} B` : `${v.toFixed(1)} ${units[u]}`
}

function protectionTone(state: BackupProtection['state']): Tone {
  return state === 'protected' ? 'ok' : state === 'unprotected' ? 'error' : 'warn'
}

/** The measured protection of a cluster: the state, why it is not protected, RPO, RTO, drills. */
export function protectionBlocks(p: BackupProtection, now: number): Block[] {
  return [
    {
      kind: 'status',
      word: p.state,
      tone: protectionTone(p.state),
      ...(p.reasons.length === 0 ? {} : { text: `because ${p.reasons.join(', ')}` }),
    },
    {
      kind: 'fields',
      rows: [
        [
          'RPO (measured)',
          p.rpo.achievableSeconds === null
            ? null
            : `${seconds(p.rpo.achievableSeconds)}${p.rpo.uncertaintySeconds === null ? '' : ` ± ${seconds(p.rpo.uncertaintySeconds)}`} (from ${p.rpo.basis.replaceAll('_', ' ')})`,
        ],
        [
          'RPO objective',
          p.rpo.objectiveSeconds === null ? 'not set' : seconds(p.rpo.objectiveSeconds),
        ],
        [
          'RTO (measured)',
          p.rto.measuredSeconds === null
            ? 'not measured (no passed drill)'
            : `${seconds(p.rto.measuredSeconds)} (drill ${dash(p.rto.drillId)}, ${ago(p.rto.drillAt, now)})`,
        ],
        [
          'RTO objective',
          p.rto.objectiveSeconds === null ? 'not set' : seconds(p.rto.objectiveSeconds),
        ],
        [
          'PITR window',
          p.pitrWindow === null ? 'none' : `${p.pitrWindow.from} to ${p.pitrWindow.to}`,
        ],
        [
          'Last verified backup',
          p.lastVerifiedBackupAt === null ? 'never' : ago(p.lastVerifiedBackupAt, now),
        ],
        [
          'Drills',
          `${p.drill.state.replaceAll('_', ' ')}${p.drill.lastPassedAt === null ? '' : `, last passed ${ago(p.drill.lastPassedAt, now)}`}${p.drill.cadenceDays === null ? '' : `, every ${p.drill.cadenceDays} days`}`,
        ],
      ],
    },
  ]
}

const lockText = (l: BackupRepository['lock']) =>
  `${l.mode} (${l.capability === 'proven' ? 'proven' : 'not proven'})`

function locationText(r: BackupRepository): string {
  const l = r.location
  if (l === null) return 'withheld'
  const where = l.bucket === null ? `(posix) ${l.prefix}` : `${l.bucket}/${l.prefix}`
  return l.stanza === null ? where : `${where} stanza ${l.stanza} repo${l.repoIndex ?? '?'}`
}

/** A body that only a file gives (a request too rich for flags). */
const fileOnly = (what: string) => (): Record<string, unknown> => {
  throw new UsageError(`Give the ${what} with --file (JSON or YAML, checked against the contract).`)
}

/** `--selection`: latest, older, pitr_random, backup:<bkp_…> or pitr:<RFC 3339 time>. */
export function drillSelection(v: string): Record<string, unknown> {
  if (v === 'latest' || v === 'older' || v === 'pitr_random') return { kind: v }
  if (v.startsWith('backup:')) return { kind: 'backup', backupId: v.slice('backup:'.length) }
  if (v.startsWith('pitr:')) return { kind: 'pitr', at: v.slice('pitr:'.length) }
  throw new UsageError(
    '--selection is latest, older, pitr_random, backup:<bkp_…> or pitr:<RFC 3339 time>.',
  )
}

/** A required acknowledgement flag: only an explicit `--name` (true) counts. */
function acknowledged(input: CommandInput, name: string, meaning: string): true {
  if (input.flags[name] !== true) {
    throw new UsageError(`--${name} is required: ${meaning}`)
  }
  return true
}

function drillBlocks(d: Drill, now: number): Block[] {
  return [
    {
      kind: 'fields',
      rows: [
        ['Drill', d.id],
        [
          'Mode',
          d.mode === 'offline_runbook' ? 'offline runbook (an attestation)' : 'control plane',
        ],
        ['Outcome', d.outcome],
        ['Selection', d.selection],
        ['Repository', d.repositoryId],
        ['Restore', d.restoreId],
        ['Measured RTO', d.measuredRtoSeconds === null ? null : seconds(d.measuredRtoSeconds)],
        ['Started', ago(d.startedAt, now)],
        ['Finished', ago(d.finishedAt, now)],
      ],
    },
  ]
}

/** The sha256 digest of a runbook's script as the contract names it. */
export const runbookDigest = (script: string): string =>
  `sha256:${createHash('sha256').update(script, 'utf8').digest('hex')}`

function runbookFacts(rb: RestoreRunbook, where: string): Block[] {
  return [
    {
      kind: 'fields',
      rows: [
        ['Written to', where],
        ['Digest', rb.digest],
        ['Repository', `${rb.repositoryId} (revision ${rb.repositoryRevision})`],
        ['Generated', rb.generatedAt],
      ],
    },
    {
      kind: 'table',
      columns: [{ title: 'PLACEHOLDER' }, { title: 'MEANING', flexible: true }],
      rows: rb.placeholders.map((p) => [p.name, p.meaning]),
      empty: 'No placeholders.',
    },
    {
      kind: 'text',
      tone: 'muted',
      lines: [
        'Fill each placeholder from the offline material; the script reads every secret from a file, never from an argument.',
        'Record the drill afterwards with: exponetdb drill record-offline <cluster> --file <record.yaml> (with this digest).',
      ],
    },
  ]
}

export const backupCommands: readonly CommandSpec[] = [
  // ----- reads -----
  fieldListCommand({
    path: ['backup', 'overview'],
    summary:
      'Backup protection of every cluster you may read: state, measured RPO, last verified backup and drills.',
    description:
      'Computed by the server from the catalog mirror. The counts cover every cluster you may read; the table is a page (--limit, --all, --cursor).',
    group: 'backup',
    flags: [
      {
        name: 'state',
        type: 'enum',
        values: PROTECTION_STATES,
        description: 'Only clusters with this protection state.',
      },
    ],
    action: 'backup.overview',
    scopes: READ,
    output: 'BackupOverview',
    title: 'backups',
    operation: 'getBackupOverview',
    field: 'clusters',
    noun: 'cluster',
    query: (i) => (flag(i, 'state') === undefined ? {} : { state: flag(i, 'state') }),
    facts: (o, now) => [
      {
        kind: 'fields',
        rows: [
          [
            'Clusters',
            `${o.counts.protected} protected, ${o.counts.atRisk} at risk, ${o.counts.unprotected} unprotected, ${o.counts.unproven} unproven, ${o.counts.unknown} unknown`,
          ],
          ['Read', `${o.source}, ${ago(o.observedAt, now)}`],
        ],
      },
    ],
    columns: [
      { title: 'CLUSTER' },
      { title: 'NAME', flexible: true },
      { title: 'MODE' },
      { title: 'REPOS', align: 'right' },
      { title: 'PROTECTION' },
      { title: 'RPO', align: 'right' },
      { title: 'LAST VERIFIED' },
      { title: 'DRILLS' },
      { title: 'REASONS', flexible: true },
    ],
    row: (c, now) => [
      c.clusterId,
      c.displayName,
      c.managementMode,
      String(c.repositories),
      c.protection.state,
      seconds(c.protection.rpo.achievableSeconds),
      c.protection.lastVerifiedBackupAt === null
        ? 'never'
        : ago(c.protection.lastVerifiedBackupAt, now),
      c.protection.drill.state.replaceAll('_', ' '),
      c.protection.reasons.length === 0 ? '-' : c.protection.reasons.join(', '),
    ],
    empty: 'No clusters you may read.',
  }),
  fieldListCommand({
    path: ['backup', 'list'],
    summary:
      'A cluster’s backups from the catalog mirror, with its protection, repositories and WAL coverage.',
    description:
      'A backup the latest engine catalog no longer lists is marked "missing in engine" and never counts as protection. The backups are paged (--limit, --all, --cursor); refresh the mirror with `backup refresh`.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'backup.list',
    scopes: READ,
    output: 'BackupCatalog',
    title: 'backups',
    operation: 'listClusterBackups',
    field: 'backups',
    noun: 'backup',
    pageMax: 500,
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    facts: (c, now) => [
      ...protectionBlocks(c.protection, now),
      {
        kind: 'fields',
        rows: [
          ['Catalog', `${c.state}, ${c.source}, ${ago(c.observedAt, now)}`],
          [
            'WAL window',
            c.walWindow === null ? 'none' : `${c.walWindow.from} to ${c.walWindow.to}`,
          ],
          ['Last drill', c.lastDrillAt === null ? 'never' : ago(c.lastDrillAt, now)],
          ...(c.truncated ? [['Note', 'truncated by the server'] as [string, string]] : []),
        ],
      },
      {
        kind: 'table',
        columns: [
          { title: 'REPOSITORY' },
          { title: 'LAYER' },
          { title: 'ENGINE' },
          { title: 'PROVIDER' },
          { title: 'OWNERSHIP' },
          { title: 'STATE' },
          { title: 'LOCK' },
          { title: 'RECONCILED' },
        ],
        rows: c.repositories.map((r) => [
          r.id,
          r.layer,
          r.engine,
          r.provider,
          r.ownership,
          r.state,
          r.lockCapability === 'proven' ? 'proven' : 'not proven',
          r.reconciledAt === null ? 'never' : ago(r.reconciledAt, now),
        ]),
        empty: 'No repositories.',
      },
      {
        kind: 'table',
        columns: [
          { title: 'WAL OF' },
          { title: 'TIMELINE', align: 'right' },
          { title: 'FROM', flexible: true },
          { title: 'TO', flexible: true },
          { title: 'GAPS', align: 'right' },
        ],
        rows: c.walCoverage.map((w) => [
          w.repositoryId,
          String(w.timeline),
          `${w.from.lsn} ${dash(w.from.at)}`,
          `${w.to.lsn} ${dash(w.to.at)}`,
          String(w.gaps.length),
        ]),
        empty: 'No WAL coverage observed.',
      },
    ],
    columns: [
      { title: 'BACKUP' },
      { title: 'REPOSITORY' },
      { title: 'KIND' },
      { title: 'STATE' },
      { title: 'VERIFIED' },
      { title: 'SIZE', align: 'right' },
      { title: 'STARTED' },
      { title: 'NOTE' },
      { title: 'LABEL', flexible: true },
    ],
    row: (b, now) => [
      b.id,
      b.repositoryId,
      b.kind,
      b.state,
      b.verification.state,
      bytes(b.sizeBytes),
      ago(b.startedAt, now),
      b.divergence === 'none' ? '-' : 'missing in engine',
      b.engineLabel,
    ],
    empty: 'No backups in the catalog mirror.',
  }),
  showCommand({
    path: ['backup', 'repositories'],
    summary:
      'The backup repositories of a cluster: ownership, lock capability, engine advisory and reconciliation.',
    description:
      'The location (endpoint, bucket, prefix, stanza) is shown only to callers with registry.manage; a key or credential is never shown.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'backup.repository.list',
    scopes: READ,
    output: 'BackupRepositoryList',
    title: 'backup repositories',
    operation: 'listBackupRepositories',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    view: (l, now) => [
      { kind: 'fields', rows: [['Read', `${l.source}, ${ago(l.observedAt, now)}`]] },
      {
        kind: 'table',
        columns: [
          { title: 'REPOSITORY' },
          { title: 'LAYER' },
          { title: 'ENGINE' },
          { title: 'PROVIDER' },
          { title: 'PURPOSE' },
          { title: 'OWNERSHIP' },
          { title: 'STATE' },
          { title: 'LOCK' },
          { title: 'ADVISORY' },
          { title: 'RECONCILED' },
          { title: 'LOCATION', flexible: true },
        ],
        rows: l.repositories.map((r) => [
          r.id,
          r.layer,
          r.engine,
          r.provider,
          r.purpose,
          r.ownership,
          r.state,
          lockText(r.lock),
          r.engineVersion.advisory,
          r.reconciliation === null
            ? 'never'
            : `${r.reconciliation.outcome} ${ago(r.reconciliation.at, now)}`,
          locationText(r),
        ]),
        empty: 'No repositories.',
      },
    ],
  }),
  showCommand({
    path: ['backup', 'policy', 'show'],
    summary:
      'The active backup policy of a cluster: schedules, retention, objectives, drill cadence.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'backup.policy.get',
    scopes: READ,
    output: 'BackupPolicyView',
    title: 'backup policy',
    operation: 'getBackupPolicy',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    view: (v, now) => {
      const p = v.policy
      if (p === null) return [{ kind: 'text', lines: ['No backup policy is set.'] }]
      return [
        {
          kind: 'fields',
          rows: [
            ['Policy', `${p.id} (revision ${p.revision}, ${p.state})`],
            ['Set by', p.operationId],
            ['Created', ago(p.createdAt, now)],
            [
              'Retention',
              `fulls ${dash(p.retention.fullCount)}, differentials ${dash(p.retention.differentialCount)}, logical days ${dash(p.retention.logicalDays)}`,
            ],
            [
              'Archive timeout',
              p.archiveTimeoutSeconds === null ? 'not set' : seconds(p.archiveTimeoutSeconds),
            ],
            [
              'RPO objective',
              p.objectives.rpoSeconds === null ? 'not set' : seconds(p.objectives.rpoSeconds),
            ],
            [
              'RTO objective',
              p.objectives.rtoSeconds === null ? 'not set' : seconds(p.objectives.rtoSeconds),
            ],
            ['Drill cadence', `every ${p.drillCadenceDays} days`],
            ['Size floor', `${p.sizeFloorPercent}%`],
            ['Read', `${v.source}, ${ago(v.observedAt, now)}`],
          ],
        },
        {
          kind: 'table',
          columns: [
            { title: 'KIND' },
            { title: 'REPOSITORY' },
            { title: 'CRON (UTC)' },
            { title: 'ENABLED' },
          ],
          rows: p.schedules.map((s) => [s.kind, s.repositoryId, s.cron, s.enabled ? 'yes' : 'no']),
          empty: 'No schedules.',
        },
      ]
    },
    next: (v) =>
      v.policy === null ? [`exponetdb backup policy set ${v.clusterId} --file policy.yaml`] : [],
  }),
  fieldListCommand({
    path: ['backup', 'runs'],
    summary: 'Engine runs of a cluster: backups, verifies, expiry, restores and discards.',
    description:
      'A run that is lost (it disappeared, e.g. a host reboot) or unknown (the node could not be asked) is never retried automatically for restores, expiry or verification.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'backup.run.list',
    scopes: READ,
    output: 'EngineRunList',
    title: 'engine runs',
    operation: 'listBackupRuns',
    field: 'runs',
    noun: 'run',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    columns: [
      { title: 'RUN' },
      { title: 'PURPOSE' },
      { title: 'STATE' },
      { title: 'REPOSITORY' },
      { title: 'NODE' },
      { title: 'STARTED' },
      { title: 'FINISHED' },
      { title: 'PROGRESS', align: 'right' },
      { title: 'ERROR' },
    ],
    row: (r, now) => [
      r.id,
      r.purpose,
      r.state,
      dash(r.repositoryId),
      r.nodeId,
      ago(r.startedAt, now),
      ago(r.finishedAt, now),
      r.progress?.percent === null || r.progress?.percent === undefined
        ? '-'
        : `${r.progress.percent}%`,
      dash(r.errorCode),
    ],
    empty: 'No engine runs.',
  }),

  // ----- repositories and policy (plans) -----
  planCommand({
    path: ['backup', 'adopt'],
    summary:
      'Plan adopting an existing backup repository for read-only observation (nothing changes on the host or in the bucket).',
    description:
      'The file names layer, engine, provider and location (endpoint host, region, bucket, prefix, and for pgBackRest the stanza and repository index), and optionally priority, purpose, the declared lock mode, cipher and pinned engine version. It never holds a key or a credential: the engine reads them on the host (secret source host_config). The repository starts as adopted_observed.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'backup.repository.adopt.plan',
    scopes: MANAGE,
    operation: 'planBackupRepositoryAdoption',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    body: fileOnly('adoption request'),
    examples: ['exponetdb backup adopt cls_01J… --file repository.yaml'],
  }),
  planCommand({
    path: ['backup', 'ownership'],
    summary:
      'Plan what ExponetDB may do with an adopted repository (adopted_runs: start runs with the host configuration).',
    description:
      'adopted_runs lets ExponetDB start incremental backups and verifies with the configuration the host already has, never changing configuration, schedules, keys or retention; --host-configuration-unchanged states that and is required. owned is refused by the server until its capability exists.',
    group: 'backup',
    args: [{ name: 'repository', description: 'A backup repository id (bkr_…).', required: true }],
    flags: [
      {
        name: 'to',
        type: 'enum',
        values: ['adopted_runs', 'owned'],
        description: 'The ownership to plan.',
        required: true,
      },
      {
        name: 'host-configuration-unchanged',
        type: 'boolean',
        description:
          'Acknowledge that the host configuration, schedules, keys and retention stay as they are.',
        required: true,
      },
    ],
    action: 'backup.repository.ownership.plan',
    scopes: MANAGE,
    operation: 'planBackupRepositoryOwnership',
    params: (i) => ({ repositoryId: arg(i, 'repository') }),
    body: (i) => ({
      to: String(i.flags['to']),
      acknowledge: {
        hostConfigurationUnchanged: acknowledged(
          i,
          'host-configuration-unchanged',
          'the host configuration, schedules, keys and retention stay as they are.',
        ),
      },
    }),
    file: false,
  }),
  planCommand({
    path: ['backup', 'retire-repository'],
    summary:
      'Plan retiring a backup repository record: it is no longer observed or used; nothing in storage is deleted.',
    group: 'backup',
    args: [{ name: 'repository', description: 'A backup repository id (bkr_…).', required: true }],
    flags: [
      {
        name: 'storage-kept',
        type: 'boolean',
        description:
          'Acknowledge that nothing in the bucket or on the host is deleted; only the record leaves ExponetDB.',
        required: true,
      },
      {
        name: 'no-longer-protected',
        type: 'boolean',
        description:
          'Acknowledge that the cluster is no longer protected by this repository through ExponetDB.',
        required: true,
      },
      { name: 'reason', type: 'string', placeholder: 'text', description: 'Why.' },
    ],
    action: 'backup.repository.retire.plan',
    scopes: MANAGE,
    operation: 'planBackupRepositoryRetirement',
    params: (i) => ({ repositoryId: arg(i, 'repository') }),
    body: (i) => ({
      acknowledge: {
        storageKept: acknowledged(
          i,
          'storage-kept',
          'nothing in the bucket or on the host is deleted; only the record leaves ExponetDB.',
        ),
        noLongerProtectedByExponetdb: acknowledged(
          i,
          'no-longer-protected',
          'the cluster is no longer protected by this repository through ExponetDB.',
        ),
      },
      ...(flag(i, 'reason') === undefined ? {} : { reason: flag(i, 'reason') }),
    }),
    file: false,
  }),
  planCommand({
    path: ['backup', 'policy', 'set'],
    summary:
      'Plan a new revision of a cluster’s backup policy (high: a person applies it with a fresh re-authentication).',
    description:
      'The file holds schedules (kind, repository, five-field UTC cron, enabled), retention, the archive timeout, the RPO and RTO objectives, the drill cadence and the size floor.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'backup.policy.set.plan',
    scopes: MANAGE,
    operation: 'planBackupPolicy',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    body: fileOnly('policy'),
    examples: ['exponetdb backup policy set cls_01J… --file policy.yaml'],
  }),

  // ----- runs and the catalog -----
  {
    path: ['backup', 'refresh'],
    summary:
      'Read the engine catalog of every observed repository of a cluster through its node into the mirror.',
    description:
      'An inline operation (low): the node runs backup.list@1 and the mirror is reconciled. Waits by default; exit 0 only when it succeeded.',
    group: 'backup',
    args: [CLUSTER_ARG],
    flags: WAIT_FLAGS,
    locality: 'remote',
    effect: 'mutation',
    action: 'backup.catalog.refresh',
    scopes: RUN,
    output: 'Operation',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const op = must(
        await remote.sdk.call('refreshBackupCatalog', {
          params: { clusterId: arg(input, 'cluster') },
          body: {},
          idempotencyKey: randomUUID(),
        }),
      )
      return inlineResult(ctx, remote, 'backup refresh', op, input.flags)
    },
  },
  planCommand({
    path: ['backup', 'run'],
    summary:
      'Plan a backup run into one repository (refused unless backup execution is activated and the repository allows runs).',
    group: 'backup',
    args: [CLUSTER_ARG],
    flags: [
      REPOSITORY_FLAG,
      {
        name: 'kind',
        type: 'enum',
        values: KINDS,
        description: 'The backup kind.',
        required: true,
      },
    ],
    action: 'backup.run.plan',
    scopes: RUN,
    operation: 'planBackupRun',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    body: (i) => ({ repositoryId: String(i.flags['repository']), kind: String(i.flags['kind']) }),
    file: false,
  }),
  {
    path: ['backup', 'verify'],
    summary:
      'Verify one backup with the engine’s verify command; it counts as verified only after the run passed.',
    description: 'An inline operation (low). Waits by default; exit 0 only when the verify passed.',
    group: 'backup',
    args: [CLUSTER_ARG, { name: 'backup', description: 'A backup id (bkp_…).', required: true }],
    flags: WAIT_FLAGS,
    locality: 'remote',
    effect: 'mutation',
    action: 'backup.verify',
    scopes: RUN,
    output: 'Operation',
    async run(ctx, input) {
      const remote = await ctx.remote()
      const op = must(
        await remote.sdk.call('verifyBackup', {
          params: { clusterId: arg(input, 'cluster'), backupId: arg(input, 'backup') },
          body: {},
          idempotencyKey: randomUUID(),
        }),
      )
      return inlineResult(ctx, remote, 'backup verify', op, input.flags)
    },
  },

  // ----- restores -----
  planCommand({
    path: ['restore', 'plan'],
    summary:
      'Plan a recovery of a target into a new cluster directory on a node (never in place); a person applies it with `plan apply`.',
    description:
      'The file names purpose recovery, the repository, the source (backupId, pointInTime or latest: true), the destination (kind new_cluster, nodeId) and the reason (an incident reference). The plan is shown, never run here: a person reviews it and applies it with `exponetdb plan apply <plan>`, which asks for a fresh re-authentication in the browser (restore.execute, human only). Switching the target to the restored cluster is a separate placement plan.',
    group: 'backup',
    args: [{ name: 'target', description: 'A target id or path.', required: true }],
    action: 'restore.plan',
    scopes: RESTORE_PLAN,
    operation: 'planRestore',
    params: (i) => ({ target: arg(i, 'target') }),
    body: fileOnly('recovery request'),
    apply: false,
    examples: [
      'exponetdb restore plan demo/platform/staging --file recovery.yaml',
      'exponetdb plan apply pln_01J…',
    ],
  }),
  fieldListCommand({
    path: ['restore', 'list'],
    summary: 'Restores of a cluster (drills and recoveries) with their phases and checks.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'restore.list',
    scopes: READ,
    output: 'RestoreList',
    title: 'restores',
    operation: 'listRestores',
    field: 'restores',
    noun: 'restore',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    columns: [
      { title: 'RESTORE' },
      { title: 'PURPOSE' },
      { title: 'STATE' },
      { title: 'TARGET' },
      { title: 'SOURCE', flexible: true },
      { title: 'DESTINATION' },
      { title: 'CHECKS' },
      { title: 'CREATED' },
    ],
    row: (r, now) => [
      r.id,
      r.purpose,
      r.state,
      dash(r.targetId),
      `${r.source.repositoryId} ${r.source.backupId ?? r.source.pointInTime ?? 'latest'}`,
      `${r.destination.kind} on ${r.destination.nodeId}`,
      r.checks.length === 0
        ? '-'
        : `${r.checks.filter((c) => c.outcome === 'passed').length}/${r.checks.length} passed`,
      ago(r.createdAt, now),
    ],
    empty: 'No restores.',
  }),
  planCommand({
    path: ['restore', 'discard'],
    summary:
      'Plan discarding a scratch restore: stop its temporary cluster and remove its directory on the node.',
    description:
      'Human only (restore.execute); applying it asks for a fresh re-authentication in the browser.',
    group: 'backup',
    args: [CLUSTER_ARG, { name: 'restore', description: 'A restore id (rst_…).', required: true }],
    action: 'restore.discard.plan',
    scopes: RESTORE_EXECUTE,
    operation: 'planRestoreDiscard',
    params: (i) => ({ clusterId: arg(i, 'cluster'), restoreId: arg(i, 'restore') }),
    file: false,
  }),
  {
    path: ['restore', 'runbook'],
    summary:
      'Write the offline restore runbook of a repository (plain POSIX shell, placeholders for every secret) to a new file.',
    description:
      'The runbook restores without ExponetDB (C-35). It is written to a new file with mode 0700 and never over an existing one; `--out -` prints it to stdout (the digest and placeholders go to stderr). The script is checked against its digest before it is written; the download is audited.',
    group: 'backup',
    args: [CLUSTER_ARG],
    flags: [
      REPOSITORY_FLAG,
      {
        name: 'out',
        type: 'string',
        placeholder: 'file|-',
        description: 'A new file for the script, or - for stdout.',
        required: true,
      },
    ],
    locality: 'remote',
    effect: 'read',
    action: 'restore.runbook.get',
    scopes: RESTORE_PLAN,
    output: 'RestoreRunbook',
    examples: ['exponetdb restore runbook cls_01J… --repository bkr_01J… --out ./restore.sh'],
    async run(ctx, input) {
      const out = String(input.flags['out'])
      const path = out === '-' ? undefined : resolve(ctx.io.cwd, out)
      // Refused before the (audited) download when the file exists.
      if (path !== undefined) await checkNewPrivateFile(path)
      const remote = await ctx.remote()
      const rb = must(
        await remote.sdk.call('getRestoreRunbook', {
          params: { clusterId: arg(input, 'cluster') },
          query: { repository: String(input.flags['repository']) },
        }),
      )
      if (runbookDigest(rb.script) !== rb.digest) {
        throw new CliError(
          'RUNBOOK_DIGEST_MISMATCH',
          'The runbook does not match its digest; nothing was written.',
        )
      }
      if (path === undefined) {
        if (ctx.format !== 'table') {
          return result({ command: 'restore runbook', data: rb, blocks: [] })
        }
        if (clean(rb.script) !== rb.script) {
          throw new CliError(
            'RUNBOOK_UNSAFE',
            'The runbook holds terminal control characters; write it to a file with --out <file>.',
          )
        }
        ctx.io.stdout(rb.script)
        ctx.io.stderr(`Digest: ${rb.digest}\n`)
        for (const p of rb.placeholders) {
          ctx.io.stderr(`Placeholder ${p.name}: ${clean(p.meaning).replace(/\s+/g, ' ')}\n`)
        }
        return result({ command: 'restore runbook', data: rb, blocks: [] })
      }
      await createNewPrivateFile(path, rb.script, 0o700)
      const { script: _script, ...facts } = rb
      return result({
        command: 'restore runbook',
        data: { ...facts, path },
        blocks: [
          header(`restore runbook ${rb.filename}`, remote.context),
          ...runbookFacts(rb, path),
        ],
      })
    },
  },

  // ----- drills -----
  planCommand({
    path: ['drill', 'plan'],
    summary:
      'Plan a restore drill into scratch on a node: the latest backup, an older one, a random point in time, or a named backup or time.',
    description:
      'A drill always restores into a scratch directory, never over a cluster. Applying it is human only (restore.execute) with a fresh re-authentication in the browser.',
    group: 'backup',
    args: [CLUSTER_ARG],
    flags: [
      REPOSITORY_FLAG,
      {
        name: 'selection',
        type: 'string',
        placeholder: 'latest|older|pitr_random|backup:<bkp_…>|pitr:<time>',
        description: 'What to restore.',
        required: true,
      },
      {
        name: 'node',
        type: 'string',
        placeholder: 'nod_…',
        description: 'The node to restore on (default: the cluster’s own node).',
      },
    ],
    action: 'restore.drill.plan',
    scopes: RESTORE_PLAN,
    operation: 'planDrill',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    body: (i) => ({
      repositoryId: String(i.flags['repository']),
      selection: drillSelection(String(i.flags['selection'])),
      ...(flag(i, 'node') === undefined ? {} : { nodeId: flag(i, 'node') }),
    }),
    examples: [
      'exponetdb drill plan cls_01J… --repository bkr_01J… --selection pitr_random',
      'exponetdb drill plan cls_01J… --repository bkr_01J… --selection pitr:2026-10-20T08:00:00Z',
    ],
  }),
  fieldListCommand({
    path: ['drill', 'list'],
    summary: 'Drills of a cluster with their outcome and measured duration.',
    description: 'A drill recorded from the offline runbook is an attestation and shows as such.',
    group: 'backup',
    args: [CLUSTER_ARG],
    action: 'restore.list',
    scopes: READ,
    output: 'DrillList',
    title: 'drills',
    operation: 'listDrills',
    field: 'drills',
    noun: 'drill',
    params: (i) => ({ clusterId: arg(i, 'cluster') }),
    columns: [
      { title: 'DRILL' },
      { title: 'SELECTION' },
      { title: 'MODE' },
      { title: 'OUTCOME' },
      { title: 'RTO', align: 'right' },
      { title: 'REPOSITORY' },
      { title: 'RESTORE' },
      { title: 'STARTED' },
    ],
    row: (d, now) => [
      d.id,
      d.selection,
      d.mode === 'offline_runbook' ? 'offline (attested)' : 'control plane',
      d.outcome,
      seconds(d.measuredRtoSeconds),
      d.repositoryId,
      dash(d.restoreId),
      ago(d.startedAt, now),
    ],
    empty: 'No drills.',
  }),
  {
    path: ['drill', 'record-offline'],
    summary:
      'Record a drill you ran from the offline runbook with the Control Plane stopped: an attestation, shown as such.',
    description:
      'Your statement of what you ran, where, and what you checked, with the runbook digest, the restore time, the duration and the outcome (no secrets in the notes). It is recorded as an attestation (mode offline_runbook), never as a drill ExponetDB observed. Human only (restore.execute) with a fresh re-authentication.',
    group: 'backup',
    args: [CLUSTER_ARG],
    flags: [{ ...FILE_FLAG, required: true }],
    locality: 'remote',
    effect: 'mutation',
    action: 'restore.drill.offline.record',
    scopes: RESTORE_EXECUTE,
    output: 'Drill',
    examples: ['exponetdb drill record-offline cls_01J… --file drill-record.yaml'],
    async run(ctx, input) {
      const body = checkedBody(
        'recordOfflineDrill',
        await bodyFromFile(ctx, String(input.flags['file'])),
      )
      const remote = await ctx.remote()
      const recorded = await remote.sdk.call('recordOfflineDrill', {
        params: { clusterId: arg(input, 'cluster') },
        body: body as never,
      })
      if (!recorded.ok && recorded.error.code === 'REAUTH_REQUIRED') {
        throw new RemoteFailure({
          ...recorded.error,
          remediation:
            recorded.error.remediation ??
            'Record it in the Web App after a fresh sign-in; the CLI has no step-up for this action.',
        })
      }
      const d = must(recorded)
      return result({
        command: 'drill record-offline',
        data: d,
        blocks: [
          header(`drill ${d.id} · attestation`, remote.context),
          { kind: 'status', word: d.outcome, tone: toneOf(d.outcome) },
          ...drillBlocks(d, ctx.io.now()),
        ],
      })
    },
  },
]
