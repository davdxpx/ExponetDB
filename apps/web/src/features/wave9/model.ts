import type { ResponseOf } from '../../lib/api/client.ts'
import type { MessageKey } from '../../lib/i18n/i18n.ts'

/**
 * Pure helpers of the Wave 9 pages (performance, advisors, backups): the
 * shapes the server sends, the words for its states and the arithmetic the
 * pages show (a duration, a window). Nothing here invents a value: a state
 * the page does not know is "unknown", a missing number stays missing, and
 * no state but `protected` (with a proven lock for a lock) is ever drawn as
 * good (C-28, C-30).
 */
export type QueryStats = ResponseOf<'getQueryStats'>
export type Statement = QueryStats['statements'][number]
export type Sampling = NonNullable<QueryStats['sampling']>
export type Regression = NonNullable<Statement['regression']>
export type TableStats = ResponseOf<'getTableStats'>
export type TableStat = TableStats['tables'][number]
export type IndexStat = TableStats['indexes'][number]
export type AdvisorRun = ResponseOf<'runAdvisors'>
export type AdvisorFinding = AdvisorRun['findings'][number]
export type AdvisorSkip = NonNullable<AdvisorRun['skipped']>[number]
export type BackupCatalog = ResponseOf<'listClusterBackups'>
export type BackupEntry = BackupCatalog['backups'][number]
export type Protection = BackupCatalog['protection']
export type RepositorySummary = BackupCatalog['repositories'][number]
export type WalCoverage = BackupCatalog['walCoverage'][number]
export type RepositoryList = ResponseOf<'listBackupRepositories'>
export type Repository = RepositoryList['repositories'][number]
export type PolicyView = ResponseOf<'getBackupPolicy'>
export type Policy = NonNullable<PolicyView['policy']>
export type RunList = ResponseOf<'listBackupRuns'>
export type EngineRun = RunList['runs'][number]
export type DrillList = ResponseOf<'listDrills'>
export type Drill = DrillList['drills'][number]
export type RestoreList = ResponseOf<'listRestores'>
export type Restore = RestoreList['restores'][number]
export type BackupOverview = ResponseOf<'getBackupOverview'>
export type OverviewItem = BackupOverview['clusters'][number]
export type Runbook = ResponseOf<'getRestoreRunbook'>

// ----- statements -----

export const WINDOWS = ['1h', '24h', '7d'] as const
export type StatsWindow = (typeof WINDOWS)[number]
const WINDOW_MS: Readonly<Record<StatsWindow, number>> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
}

/** The window of a statement read, ending now (ISO 8601). */
export function windowRange(window: StatsWindow, now: number): { from: string; to: string } {
  return {
    from: new Date(now - WINDOW_MS[window]).toISOString(),
    to: new Date(now).toISOString(),
  }
}

export const ORDERS = ['total_time', 'mean_time', 'calls', 'io'] as const
export type StatsOrder = (typeof ORDERS)[number]
export const STATEMENT_LIMITS = [50, 100, 500] as const
export type StatementLimit = (typeof STATEMENT_LIMITS)[number]

/** Milliseconds as the table shows them: `0.42 ms`, `12.3 ms`, `1,204 ms`, `3.2 s`. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 100) return `${ms.toFixed(1)} ms`
  if (ms < 10_000) return `${Math.round(ms).toLocaleString('en-US')} ms`
  return formatSeconds(ms / 1_000)
}

/** Seconds as a short duration: `45 s`, `12 min`, `3 h 20 min`, `2 d 4 h`. */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`
}

/** A factor as the regression badge names it: `×2.4`. */
export function formatFactor(factor: number): string {
  return Number.isFinite(factor) ? `×${factor.toFixed(1)}` : ''
}

/** Sampler states that say the statement history cannot be trusted as complete. */
export function samplingProblem(
  sampling: Sampling | undefined,
): Exclude<Sampling['state'], 'active'> | undefined {
  if (sampling === undefined || sampling.state === 'active') return undefined
  return sampling.state
}

export const SAMPLING_KEYS: Readonly<
  Record<
    Exclude<Sampling['state'], 'active'>,
    { readonly title: MessageKey; readonly body: MessageKey }
  >
> = {
  extension_missing: {
    title: 'wave9.statements.sampling.missing.title',
    body: 'wave9.statements.sampling.missing.body',
  },
  not_permitted: {
    title: 'wave9.statements.sampling.notPermitted.title',
    body: 'wave9.statements.sampling.notPermitted.body',
  },
  failing: {
    title: 'wave9.statements.sampling.failing.title',
    body: 'wave9.statements.sampling.failing.body',
  },
  not_sampled_yet: {
    title: 'wave9.statements.sampling.notYet.title',
    body: 'wave9.statements.sampling.notYet.body',
  },
}

export const RESET_KEYS: Readonly<Record<Sampling['resets'][number]['kind'], MessageKey>> = {
  stats_reset: 'wave9.statements.reset.stats',
  server_restart: 'wave9.statements.reset.restart',
  entries_deallocated: 'wave9.statements.reset.deallocated',
}

// ----- tables and indexes -----

/** An index nobody used since the statistics count: never a primary key or a unique index. */
export function isUnusedIndex(index: IndexStat): boolean {
  return index.scans === 0 && index.primary !== true && index.unique !== true
}

// ----- advisors -----

export const ADVISOR_CATEGORIES = [
  'security',
  'performance',
  'operations',
  'change_safety',
] as const
export type AdvisorCategory = (typeof ADVISOR_CATEGORIES)[number]
export const CATEGORY_KEYS: Readonly<Record<AdvisorCategory, MessageKey>> = {
  security: 'wave9.advisors.category.security',
  performance: 'wave9.advisors.category.performance',
  operations: 'wave9.advisors.category.operations',
  change_safety: 'wave9.advisors.category.changeSafety',
}
export const SKIP_KEYS: Readonly<Record<AdvisorSkip['reason'], MessageKey>> = {
  needs_node: 'wave9.advisors.skip.needsNode',
  version_unsupported: 'wave9.advisors.skip.version',
  not_permitted: 'wave9.advisors.skip.notPermitted',
  timeout: 'wave9.advisors.skip.timeout',
  error: 'wave9.advisors.skip.error',
}

/** Evidence values as text; a `null` is said as "none", never left blank. */
export function evidenceText(value: string | number | boolean | null): string {
  if (value === null) return 'none'
  return String(value)
}

// ----- protection -----

export const PROTECTION_STATES = [
  'protected',
  'at_risk',
  'unprotected',
  'unproven',
  'unknown',
] as const
export type ProtectionState = (typeof PROTECTION_STATES)[number]

export const PROTECTION_KEYS: Readonly<Record<ProtectionState, MessageKey>> = {
  protected: 'wave9.protection.state.protected',
  at_risk: 'wave9.protection.state.atRisk',
  unprotected: 'wave9.protection.state.unprotected',
  unproven: 'wave9.protection.state.unproven',
  unknown: 'wave9.protection.state.unknown',
}

/** The state the page draws: anything it does not know is `unknown`, which is never good. */
export function protectionStateOf(state: unknown): ProtectionState {
  return PROTECTION_STATES.find((known) => known === state) ?? 'unknown'
}

export type Tone = 'good' | 'warning' | 'bad' | 'neutral'

/** Only `protected` is good; `unproven` and `unknown` are neutral, never green. */
export function protectionTone(state: ProtectionState): Tone {
  switch (state) {
    case 'protected':
      return 'good'
    case 'at_risk':
      return 'warning'
    case 'unprotected':
      return 'bad'
    case 'unproven':
    case 'unknown':
      return 'neutral'
  }
}

/** The badge variant of a tone (the word is the signal; the color only helps). */
export function badgeVariant(tone: Tone): 'success' | 'warning' | 'destructive' | 'default' {
  switch (tone) {
    case 'good':
      return 'success'
    case 'warning':
      return 'warning'
    case 'bad':
      return 'destructive'
    case 'neutral':
      return 'default'
  }
}

const REASON_KEYS: Readonly<Record<string, MessageKey>> = {
  no_repository: 'wave9.reason.noRepository',
  repository_unreadable: 'wave9.reason.repositoryUnreadable',
  catalog_stale: 'wave9.reason.catalogStale',
  no_verified_backup: 'wave9.reason.noVerifiedBackup',
  wal_archive_failing: 'wave9.reason.walArchiveFailing',
  wal_gap: 'wave9.reason.walGap',
  rpo_above_objective: 'wave9.reason.rpoAboveObjective',
  rpo_unknown: 'wave9.reason.rpoUnknown',
  drill_never: 'wave9.reason.drillNever',
  drill_overdue: 'wave9.reason.drillOverdue',
  drill_failed: 'wave9.reason.drillFailed',
  lock_not_proven: 'wave9.reason.lockNotProven',
  offline_key_unconfirmed: 'wave9.reason.offlineKeyUnconfirmed',
  engine_advisory: 'wave9.reason.engineAdvisory',
  not_off_host: 'wave9.reason.notOffHost',
}

/** The sentence of a protection reason, or `undefined` for a code the page does not know (shown as the code). */
export function reasonKey(code: string): MessageKey | undefined {
  return Object.hasOwn(REASON_KEYS, code) ? REASON_KEYS[code] : undefined
}

/** The recovery point is within its objective: only when both are known. */
export function rpoWithinObjective(rpo: Protection['rpo']): boolean | undefined {
  if (rpo.achievableSeconds === null || rpo.objectiveSeconds === null) return undefined
  return rpo.achievableSeconds + (rpo.uncertaintySeconds ?? 0) <= rpo.objectiveSeconds
}

export const RPO_BASIS_KEYS: Readonly<Record<Protection['rpo']['basis'], MessageKey>> = {
  wal_archive: 'wave9.protection.rpo.basis.wal',
  verified_backup: 'wave9.protection.rpo.basis.backup',
  none: 'wave9.protection.rpo.basis.none',
}

export const DRILL_STATE_KEYS: Readonly<Record<Protection['drill']['state'], MessageKey>> = {
  passed_in_cadence: 'wave9.protection.drill.passed',
  overdue: 'wave9.protection.drill.overdue',
  failed: 'wave9.protection.drill.failed',
  never: 'wave9.protection.drill.never',
}

// ----- repositories -----

export const LOCK_KEYS: Readonly<Record<Repository['lock']['capability'], MessageKey>> = {
  proven: 'wave9.lock.proven',
  unproven: 'wave9.lock.unproven',
  unsupported: 'wave9.lock.unsupported',
  unknown: 'wave9.lock.unknown',
}

/** A lock protects only when its capability was proven; every other value renders as not proven. */
export function lockProtects(capability: string): boolean {
  return capability === 'proven'
}

export const OWNERSHIP_KEYS: Readonly<Record<Repository['ownership'], MessageKey>> = {
  external: 'wave9.ownership.external',
  adopted_observed: 'wave9.ownership.adoptedObserved',
  adopted_runs: 'wave9.ownership.adoptedRuns',
  owned: 'wave9.ownership.owned',
}

export const PROVIDER_KEYS: Readonly<Record<Repository['provider'], MessageKey>> = {
  hetzner_object_storage: 'wave9.provider.hetzner',
  cloudflare_r2: 'wave9.provider.r2',
  s3_compatible: 'wave9.provider.s3',
  posix: 'wave9.provider.posix',
}

export const LAYER_KEYS: Readonly<Record<Repository['layer'], MessageKey>> = {
  l1_physical: 'wave9.layer.l1',
  l2_logical: 'wave9.layer.l2',
  l3_offprovider: 'wave9.layer.l3',
}

export const ADVISORY_KEYS: Readonly<Record<Repository['engineVersion']['advisory'], MessageKey>> =
  {
    none: 'wave9.advisory.none',
    below_floor: 'wave9.advisory.belowFloor',
    subkey_check_missing: 'wave9.advisory.subkey',
    unknown: 'wave9.advisory.unknown',
  }

/** A repository whose record lets ExponetDB start runs (the server still decides). */
export function allowsRuns(ownership: string): boolean {
  return ownership === 'adopted_runs' || ownership === 'owned'
}

/** A repository ExponetDB reads its catalog from (restores and drills come from these). */
export function isObserved(ownership: string): boolean {
  return ownership !== 'external'
}

// ----- runs, drills, restores -----

/** States of a scratch restore that still hold a temporary cluster on the node. */
export function isDiscardable(restore: Restore): boolean {
  return (
    restore.destination.kind === 'scratch' &&
    restore.state !== 'discarded' &&
    restore.state !== 'promoted' &&
    restore.state !== 'planned'
  )
}

/** Only a passed drill's measured time counts; an attestation is labeled as one, a failure never counts. */
export function drillTone(drill: Drill): Tone {
  switch (drill.outcome) {
    case 'passed':
      return 'good'
    case 'failed':
    case 'aborted':
      return 'bad'
    case 'attested':
    case 'pending':
      return 'neutral'
  }
}

export function runTone(state: EngineRun['state']): Tone {
  switch (state) {
    case 'succeeded':
      return 'good'
    case 'failed':
    case 'lost':
      return 'bad'
    case 'canceled':
      return 'warning'
    case 'starting':
    case 'running':
    case 'unknown':
      return 'neutral'
  }
}

export function restoreTone(state: Restore['state']): Tone {
  switch (state) {
    case 'ready':
    case 'promoted':
      return 'good'
    case 'failed':
      return 'bad'
    case 'needs_attention':
      return 'warning'
    default:
      return 'neutral'
  }
}

export function backupTone(entry: BackupEntry): Tone {
  if (entry.divergence !== 'none' || entry.state === 'failed') return 'bad'
  if (entry.state === 'running') return 'neutral'
  return entry.verification.state === 'passed'
    ? 'good'
    : entry.verification.state === 'failed'
      ? 'bad'
      : 'neutral'
}

/** The runbook's digest as the browser computes it over the script's UTF-8 bytes, or `undefined` when it cannot. */
export async function digestOf(script: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) return undefined
  try {
    const bytes = new TextEncoder().encode(script)
    const hash = new Uint8Array(await subtle.digest('SHA-256', bytes))
    return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return undefined
  }
}

const ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}'
const BACKUP_ID = new RegExp(`^bkp_${ULID}$`)
const REPOSITORY_ID = new RegExp(`^bkr_${ULID}$`)
const RESTORE_ID = new RegExp(`^rst_${ULID}$`)
const NODE_ID = new RegExp(`^nod_${ULID}$`)

/** Ids the page puts in a request only after they passed the contract's grammar (C-26). */
export const isBackupId = (value: unknown): value is string =>
  typeof value === 'string' && BACKUP_ID.test(value)
export const isRepositoryId = (value: unknown): value is string =>
  typeof value === 'string' && REPOSITORY_ID.test(value)
export const isRestoreId = (value: unknown): value is string =>
  typeof value === 'string' && RESTORE_ID.test(value)
export const isNodeId = (value: unknown): value is string =>
  typeof value === 'string' && NODE_ID.test(value)

/** `1536` as `1.5 KiB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

/** `validateSearch` of `/backups`: `state` is one of the contract's values or absent (never raw text). */
export interface GlobalBackupsSearch {
  readonly state?: ProtectionState
}

export function globalBackupsSearch(search: Record<string, unknown>): GlobalBackupsSearch {
  const state = PROTECTION_STATES.find((value) => value === search['state'])
  return { state }
}

export function backupsHref(state: ProtectionState | undefined): string {
  return state === undefined ? '/backups' : `/backups?state=${state}`
}
