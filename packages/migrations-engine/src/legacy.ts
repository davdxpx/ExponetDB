import type { Queryable, Tx } from '@exponetdb/control-store'
import { canonicalBytes, type JsonObject, newId } from '@exponetdb/kernel'
import { sha256Hex } from '@exponetdb/kernel/hash'
import { legacyDigests, normalizeSqlSource } from '@exponetdb/migrations/format'
import {
  type ChangedBinding,
  createPlan,
  type ExecutionContext,
  type ExecutionOutcome,
  leaseHeld,
  type OperationKind,
  type PlanRecord,
  readPlan,
} from '@exponetdb/operations'
import {
  type CanonicalDocument,
  type CatalogReader,
  checkClusterGlobalExpectations,
  checkExpectations,
  diffDocuments,
  executionRoleFacts,
  executionRoleProblem,
  extensionPlacements,
  insertLedgerRow,
  insertMigrationEvent,
  insertVerification,
  LockUnavailable,
  lockMarker,
  pinSearchPath,
  readLedgerMeta,
  readLedgerRows,
  readVerifications,
  snapshotWithin,
  sql,
  TargetError,
  type TargetSession,
  takeTargetLock,
} from '@exponetdb/postgres'
import {
  type ClusterGlobalExpectation,
  type Expectation,
  type GuardStrictness,
  guardStrictness,
  loadClusterGlobalParsers,
  loadParser,
  type StatementFacts,
  survivingExpectations,
} from '@exponetdb/postgres/parser'
import {
  evaluateRegistryPolicy,
  findTarget,
  operationActor,
  type RegistryActor,
  RegistryError,
  type TargetRecord,
} from '@exponetdb/registry'
import { acceptBaselineSchema, rowsAfterBaseline } from './baseline-chain.ts'
import type { PlanContent, PlanItem } from './content.ts'
import { type MigrationKindDeps, projectRegistry } from './deps.ts'
import { MigrationError } from './errors.ts'
import {
  boundExceptionsHold,
  type ExceptionBinding,
  executionRolesFor,
  rolesStillUsable,
  roleUnder,
} from './execution-roles.ts'
import { runReplayAutocommit, runTransactional } from './executor.ts'
import {
  type ContentKeys,
  type ContentMatch,
  contentKeys,
  type EvidenceStrength,
  matchKeys,
  recordsTheFile,
  STRENGTH_RANK,
  supabaseVersionTime,
} from './legacy-evidence.ts'
import { refuseOversizedLegacyFiles } from './legacy-files.ts'
import { type FileReplay, fileReplay, survivingGlobals } from './legacy-replay.ts'
import type { MigrationPlanContext } from './planner.ts'
import { type Fence, fenced, LeaseLost, writeMirror, writeVerificationMirror } from './records.ts'
import { revisionsOf, type StoredRevision } from './store.ts'
import { ledgerHashOf, type ManagedScope } from './target.ts'
import { keptFailures, type Layer, type VerificationRun } from './verification.ts'
import {
  clusterGlobalFailures,
  type ExpectationFailure,
  excusedBy,
  failuresOf,
  structuralFailures,
  unreadableFailure,
} from './verification-failures.ts'

/**
 * Legacy history import ([legacy-import.md](../../../exponetdb-docs/04-migrations/legacy-import.md),
 * G6 order §36): discover, replay on an explicit scratch target, compare,
 * classify, review, baseline, verify, freeze.
 *
 * - **Analysis** (`migration.import.replay`, planned by
 *   `migration.import.analyze`): the legacy files are stored exactly as
 *   submitted and replayed, in the declared order, on a registered, empty
 *   nonprod scratch target of the same project, as the project's execution
 *   role and through the same statement admission as bundles; no endpoint a
 *   client names is ever contacted. The imported target is only read: its
 *   fingerprint document, the legacy ledgers named in the request, and each
 *   file's surviving structural expectations. Every file gets one state;
 *   ledger entries without a file and global drift become review items.
 *   Content evidence decides (a tool's hash of the bytes, the applied
 *   statements, a curated alias); a name alone is a hint and a number
 *   prefix is never evidence.
 * - **Review**: a person decides every item that needs it, with a note.
 * - **Baseline** (`migration.baseline`): with no unresolved item, one
 *   transaction on the target inserts `legacy:<stem>` rows (origin
 *   `legacy_import`) for what is accepted as applied, the `baseline:<slug>`
 *   row, the `imported` and `baselined` events and sets the ledger's
 *   baseline; the target's fingerprint must not change. Legacy ledgers on the
 *   target stay untouched. Verification checks the fingerprint and the
 *   accepted files' surviving expectations.
 */

export type ImportItemState =
  | 'recorded_present'
  | 'unrecorded_present'
  | 'recorded_missing'
  | 'unrecorded_missing'
  | 'superseded'
  | 'not_applicable'
  | 'ambiguous'

/** States a person must decide before a baseline. */
const NEEDS_DECISION: ReadonlySet<ImportItemState> = new Set([
  'recorded_missing',
  'unrecorded_missing',
  'ambiguous',
])

/** States a baseline imports as applied (decided or classified). */
const APPLIED: ReadonlySet<ImportItemState> = new Set([
  'recorded_present',
  'unrecorded_present',
  'superseded',
])

type Provenance =
  | 'legacy_file_at_import'
  | 'legacy_tool_hash'
  | 'legacy_applied_statements'
  | 'unknown'

interface ImportFile {
  readonly position: number
  readonly stem: string
  readonly bytes: Uint8Array
  readonly checksum: string
  readonly sourceDigest: string
  readonly bytesDigest: string
}

interface Hints {
  readonly ledgers: readonly ('supabase' | 'drizzle' | 'applied_migrations')[]
  /** Curated: an applied ledger name → the stem, or the stems, it stands for. */
  readonly aliases: Readonly<Record<string, string | readonly string[]>>
  readonly notApplicable: readonly string[]
  /** The replay's (and the expectation checks') search path. */
  readonly searchPath: readonly string[]
}

interface ReplayContent {
  readonly reportId: string
  readonly projectId: string
  readonly target: {
    readonly targetId: string
    readonly path: string
    readonly tier: 'prod' | 'nonprod'
    readonly generation: number
    readonly clusterSystemIdentifier: string
  }
  readonly scratch: {
    readonly targetId: string
    readonly generation: number
    readonly clusterSystemIdentifier: string
  }
  readonly baselineId: string
  /** The alias the replay runs as, and the role the registry mapped it to at planning. */
  readonly executionRoleAlias?: string
  readonly executionRole: string
  /**
   * What the planner read about the role on the scratch target, for the
   * migrator (Wave 9 order A3): the same check as an apply; the rule
   * `migration.import-execution-role` decides on it.
   */
  readonly executionRoleCheck?: { readonly role: string; readonly problem: string | null }
  /** The declared exception of the scratch environment the replay relies on (ADR-0034), if any. */
  readonly executionRoleExceptions?: Readonly<Record<string, ExceptionBinding>>
  readonly searchPath: readonly string[]
  readonly files: readonly { readonly stem: string; readonly checksum: string }[]
  readonly hints: Hints
}

// ----- Control Store records -----

async function readFiles(q: Queryable, reportId: string): Promise<ImportFile[]> {
  const { rows } = await q.query(
    'migrations.import.files',
    `SELECT position, stem, bytes, checksum, source_digest, bytes_digest
       FROM migrations.import_files WHERE report_id = $1 ORDER BY position`,
    [reportId],
  )
  return rows.map((r) => ({
    position: r.int('position'),
    stem: r.text('stem'),
    bytes: r.bytes('bytes'),
    checksum: r.text('checksum'),
    sourceDigest: r.text('source_digest'),
    bytesDigest: r.text('bytes_digest'),
  }))
}

interface ReportRecord {
  readonly reportId: string
  readonly targetId: string
  readonly projectId: string
  readonly scratchTargetId: string
  readonly baselineId: string
  readonly state: 'pending' | 'incomplete' | 'open' | 'baselined' | 'superseded'
  readonly fingerprint: string | null
  readonly replayFingerprint: string | null
  readonly incompleteReason: string | null
  readonly createdAt: string
  readonly hints: Hints
  readonly driftTotal: number | null
  readonly driftTruncated: boolean
  /** The operation that recorded the report as the baseline (state `baselined`). */
  readonly baselineOperationId: string | null
}

async function readReport(q: Queryable, reportId: string): Promise<ReportRecord | undefined> {
  const { rows } = await q.query(
    'migrations.import.report',
    `SELECT report_id, target_id, project_id, scratch_target_id, baseline_id, state, fingerprint,
            replay_fingerprint, incomplete_reason, hints, drift_total, drift_truncated,
            baseline_operation_id,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM migrations.import_reports WHERE report_id = $1`,
    [reportId],
  )
  const r = rows[0]
  if (r === undefined) return undefined
  return {
    reportId: r.text('report_id'),
    targetId: r.text('target_id'),
    projectId: r.text('project_id'),
    scratchTargetId: r.text('scratch_target_id'),
    baselineId: r.text('baseline_id'),
    state: r.text('state') as ReportRecord['state'],
    fingerprint: r.textOrNull('fingerprint'),
    replayFingerprint: r.textOrNull('replay_fingerprint'),
    incompleteReason: r.textOrNull('incomplete_reason'),
    createdAt: r.text('created_at'),
    hints: hintsFrom(r.json('hints')),
    driftTotal: r.intOrNull('drift_total'),
    driftTruncated: r.bool('drift_truncated'),
    baselineOperationId: r.textOrNull('baseline_operation_id'),
  }
}

function hintsFrom(value: unknown): Hints {
  const h = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const aliases: Record<string, string | string[]> = {}
  if (typeof h['aliases'] === 'object' && h['aliases'] !== null) {
    for (const [k, v] of Object.entries(h['aliases'])) {
      if (typeof v === 'string') aliases[k] = v
      else if (Array.isArray(v)) aliases[k] = v.filter((x): x is string => typeof x === 'string')
    }
  }
  const path = strings(h['searchPath'])
  return {
    ledgers: strings(h['ledgers']) as Hints['ledgers'],
    aliases,
    notApplicable: strings(h['notApplicable']),
    searchPath: path.length === 0 ? ['public'] : path,
  }
}

function hintsOf(report: ReportRecord): Hints {
  return report.hints
}

interface ItemRecord {
  readonly itemId: number
  readonly kind: 'file' | 'ledger_entry' | 'drift'
  readonly legacyId: string
  readonly name: string
  readonly state: ImportItemState
  readonly contentDigest: string | null
  readonly provenance: Provenance | null
  readonly appliedAt: string | null
  readonly evidence: readonly string[]
  readonly strength: EvidenceStrength | null
  /**
   * The file's surviving expectations that did not hold at the analysis
   * (follow-up 3, F1): what accepting it as applied excuses. `null`: not
   * recorded (an item analyzed before it was, or not a file).
   */
  readonly failing: readonly ExpectationFailure[] | null
  readonly decision: {
    readonly state: Exclude<ImportItemState, 'ambiguous'>
    readonly note: string
    readonly decidedAt: string
    readonly decidedBy: string
  } | null
}

async function readItems(q: Queryable, reportId: string): Promise<ItemRecord[]> {
  const { rows } = await q.query(
    'migrations.import.items',
    `SELECT item_id, kind, legacy_id, name, state, content_digest, checksum_provenance,
            to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS applied_at,
            evidence, evidence_strength, failing, decision_state, decision_note, decided_by,
            to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at
       FROM migrations.import_items WHERE report_id = $1 ORDER BY item_id`,
    [reportId],
  )
  return rows.map((r) => {
    const evidence = r.json('evidence')
    const decision = r.textOrNull('decision_state')
    return {
      itemId: r.int('item_id'),
      kind: r.text('kind') as ItemRecord['kind'],
      legacyId: r.text('legacy_id'),
      name: r.text('name'),
      state: r.text('state') as ImportItemState,
      contentDigest: r.textOrNull('content_digest'),
      provenance: r.textOrNull('checksum_provenance') as Provenance | null,
      appliedAt: r.textOrNull('applied_at'),
      evidence: Array.isArray(evidence) ? evidence.map(String) : [],
      strength: r.textOrNull('evidence_strength') as EvidenceStrength | null,
      failing: failuresOf(r.json('failing')),
      decision:
        decision === null
          ? null
          : {
              state: decision as Exclude<ImportItemState, 'ambiguous'>,
              note: r.text('decision_note'),
              decidedAt: r.text('decided_at'),
              decidedBy: r.text('decided_by'),
            },
    }
  })
}

/** The state an item stands at: the person's decision, else its classification. */
function effective(item: ItemRecord): ImportItemState {
  return item.decision?.state ?? item.state
}

function unresolvedOf(items: readonly ItemRecord[]): ItemRecord[] {
  return items.filter((i) => i.decision === null && NEEDS_DECISION.has(i.state))
}

/** The report as read through REST (ImportReport). */
export async function importReportView(q: Queryable, targetId: string, reportId: string) {
  const report = await readReport(q, reportId)
  if (report === undefined || report.targetId !== targetId) throw new MigrationError('NOT_FOUND')
  const items = await readItems(q, reportId)
  const unresolved = unresolvedOf(items).length
  return {
    id: report.reportId,
    targetId: report.targetId,
    projectId: report.projectId,
    baselineId: report.baselineId,
    // Resolved only when it can become a baseline: never over drift it does not hold.
    state:
      report.state === 'open' &&
      unresolved === 0 &&
      !report.driftTruncated &&
      report.driftTotal !== null
        ? ('resolved' as const)
        : report.state,
    createdAt: report.createdAt,
    fingerprint: report.fingerprint,
    replayFingerprint: report.replayFingerprint,
    scratchTargetId: report.scratchTargetId,
    incompleteReason: report.incompleteReason,
    items: items.map((i) => ({
      itemId: String(i.itemId),
      legacyId: i.legacyId,
      name: i.name,
      state: i.state,
      contentDigest: i.contentDigest,
      evidence: [...i.evidence],
      evidenceStrength: i.strength,
      decision:
        i.decision === null
          ? null
          : { state: i.decision.state, note: i.decision.note, decidedAt: i.decision.decidedAt },
      failing:
        i.failing === null
          ? null
          : {
              total: i.failing.length,
              items: i.failing.slice(0, FAILING_SHOWN).map((f) => ({ ...f })),
            },
    })),
    unresolved,
    driftTotal: report.driftTotal,
    driftTruncated: report.driftTruncated,
  }
}

// ----- analysis: planning -----

function invalid(path: string, code: string, message: string): RegistryError {
  return new RegistryError('VALIDATION_FAILED', { errors: [{ path, code, message }] })
}

export interface ImportAnalysisInput {
  readonly scratchTarget: string
  readonly baseline: string
  readonly files: readonly { readonly name: string; readonly text: string }[]
  readonly ledgers?: readonly ('supabase' | 'drizzle' | 'applied_migrations')[] | undefined
  readonly aliases?: Readonly<Record<string, string | readonly string[]>> | undefined
  readonly notApplicable?: readonly string[] | undefined
  readonly role?: string | undefined
  readonly searchPath?: readonly string[] | undefined
}

/** `migration.import.analyze`: stores the files and the pending report, then the replay plan. */
export async function planImportAnalysis(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  targetRef: string,
  request: ImportAnalysisInput,
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) throw new MigrationError('TARGET_NOT_FOUND')
  if (target.state !== 'active' || target.placement === null) {
    throw new MigrationError('TARGET_UNAVAILABLE')
  }
  const scratch = await findTarget(tx, request.scratchTarget)
  if (
    scratch === undefined ||
    scratch.state !== 'active' ||
    scratch.placement === null ||
    scratch.tier !== 'nonprod' ||
    scratch.projectId !== target.projectId ||
    scratch.targetId === target.targetId
  ) {
    throw invalid(
      '/scratchTarget',
      'scratch_not_usable',
      'The scratch target must be another active nonprod target of the same project.',
    )
  }
  // The replay runs on the scratch target: its environment's roles and exceptions (ADR-0034).
  const scratchRoles = await executionRolesFor(tx, scratch)
  const executionRoleAlias = request.role ?? 'owner'
  const executionRole = scratchRoles.roles[executionRoleAlias]
  if (executionRole === undefined) {
    throw invalid('/role', 'execution_role_unmapped', 'The execution role alias is not mapped.')
  }
  refuseOversizedLegacyFiles(request.files)
  const files: Omit<ImportFile, 'position'>[] = []
  const stems = new Set<string>()
  for (const [i, f] of request.files.entries()) {
    const stem = f.name.slice(0, -'.sql'.length)
    if (stems.has(stem)) {
      throw invalid(`/files/${i}/name`, 'duplicate_stem', 'Two files have the same stem.')
    }
    stems.add(stem)
    const bytes = new TextEncoder().encode(f.text)
    const digests = legacyDigests(bytes)
    if (!digests.ok) {
      throw invalid(`/files/${i}/text`, digests.error, 'The file cannot be read as SQL text.')
    }
    files.push({
      stem,
      bytes,
      checksum: digests.value.checksum,
      sourceDigest: digests.value.sourceDigest,
      bytesDigest: digests.value.bytesDigest,
    })
  }
  for (const [i, s] of (request.notApplicable ?? []).entries()) {
    if (!stems.has(s)) {
      throw invalid(`/notApplicable/${i}`, 'unknown_stem', 'Not a submitted file stem.')
    }
  }
  for (const [name, value] of Object.entries(request.aliases ?? {})) {
    const named = typeof value === 'string' ? [value] : [...value]
    if (named.length === 0 || new Set(named).size !== named.length) {
      throw invalid(
        `/aliases/${name}`,
        'alias_files',
        'An alias names one file, or several different files.',
      )
    }
    for (const s of named) {
      if (!stems.has(s)) {
        throw invalid(
          `/aliases/${name}`,
          'unknown_stem',
          'An alias names a file that was not submitted.',
        )
      }
    }
  }
  // The replay runs as the execution role on the scratch target: checked there, for the
  // migrator, exactly like an apply (the rule migration.import-execution-role decides).
  const scratchOpened = await ctx.connector.forTarget(
    scratch,
    'observer',
    `import-plan/${scratch.targetId}`,
  )
  let executionRoleCheck: { role: string; problem: string | null }
  let replayException: ExceptionBinding | null = null
  const scratchMajor = scratchOpened.session.facts.major
  try {
    const [facts] = await scratchOpened.session.readOnly((rtx) =>
      executionRoleFacts(rtx, [executionRole], 'exponetdb_migrator'),
    )
    const checked =
      facts === undefined
        ? { problem: 'missing', binding: null }
        : roleUnder(facts, scratchRoles.exceptions)
    executionRoleCheck = { role: executionRole, problem: checked.problem }
    replayException = checked.binding
  } finally {
    await scratchOpened.session.close()
  }
  // The imported target has no baseline yet (a second one is a deliberate rebaseline).
  const opened = await ctx.connector.forTarget(target, 'observer', `import-plan/${target.targetId}`)
  try {
    const meta = await opened.session.readOnly((rtx) => readLedgerMeta(rtx))
    if (meta === undefined) throw new MigrationError('LEDGER_NOT_INITIALIZED')
    if (meta.baselineId !== null) throw new MigrationError('CONFLICT')
  } finally {
    await opened.session.close()
  }
  const reportId = newId('imr', ctx.policy.clock.nowMs())
  const hints: Hints = {
    ledgers: [...new Set(request.ledgers ?? [])].sort(),
    aliases: Object.fromEntries(
      Object.entries(request.aliases ?? {}).map(([k, v]) => [
        k,
        typeof v === 'string' ? v : [...v],
      ]),
    ),
    notApplicable: [...(request.notApplicable ?? [])].sort(),
    searchPath: [...(request.searchPath ?? ['public'])],
  }
  await tx.query(
    'migrations.import.report.insert',
    `INSERT INTO migrations.import_reports
       (report_id, target_id, project_id, scratch_target_id, baseline_id, hints, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      reportId,
      target.targetId,
      target.projectId,
      scratch.targetId,
      `baseline:${request.baseline}`,
      JSON.stringify(hints),
      actor.identityId,
    ],
  )
  for (const [position, f] of files.entries()) {
    await tx.query(
      'migrations.import.file.insert',
      `INSERT INTO migrations.import_files
         (report_id, position, stem, bytes, checksum, source_digest, bytes_digest)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [reportId, position, f.stem, f.bytes, f.checksum, f.sourceDigest, f.bytesDigest],
    )
  }
  const content: ReplayContent = {
    reportId,
    projectId: target.projectId,
    target: {
      targetId: target.targetId,
      path: target.path,
      tier: target.tier,
      generation: target.generation,
      clusterSystemIdentifier: target.placement.systemIdentifier ?? '',
    },
    scratch: {
      targetId: scratch.targetId,
      generation: scratch.generation,
      clusterSystemIdentifier: scratch.placement.systemIdentifier ?? '',
    },
    baselineId: `baseline:${request.baseline}`,
    executionRoleAlias,
    executionRole,
    executionRoleCheck,
    ...(replayException === null
      ? {}
      : { executionRoleExceptions: { [executionRole]: replayException } }),
    searchPath: hints.searchPath,
    files: files.map((f) => ({ stem: f.stem, checksum: f.checksum })),
    hints,
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: 'migration.import.replay',
    actor,
    subject: {
      productId: target.productId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      targetId: target.targetId,
      tier: target.tier,
    },
    content: content as unknown as JsonObject,
  })
  const plan = await createPlan(
    tx,
    {
      kind: 'migration.import.replay',
      kindVersion: 1,
      actionClass: 'standard',
      actor: operationActor(actor),
      subject: {
        targetId: target.targetId,
        targetPath: target.path,
        tier: target.tier,
        generation: target.generation,
        clusterId: target.placement.clusterId,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: content as unknown as JsonObject,
      analysis: {
        reportId,
        files: files.length,
        scratchTargetId: scratch.targetId,
        executionRole: { role: executionRole, problem: executionRoleCheck.problem },
        replay: await replaySummary(scratchMajor, files, new Set(hints.notApplicable)),
      },
      policy,
    },
    { clock: ctx.policy.clock },
  )
  await tx.query(
    'migrations.import.report.plan',
    'UPDATE migrations.import_reports SET plan_id = $2 WHERE report_id = $1',
    [reportId, plan.planId],
  )
  return plan
}

// ----- analysis: the replay and the comparison -----

/** At most this many entries per list of the replay summary; the counts are always complete. */
const MAX_SUMMARY_ENTRIES = 500

/**
 * What the replay will elide, run in autocommit, leave to a person and
 * skip, per file (legacy-import.md §2.4), shown in the replay plan.
 */
async function replaySummary(
  major: 16 | 17 | 18,
  files: readonly Pick<ImportFile, 'stem' | 'bytes'>[],
  skipped: ReadonlySet<string>,
): Promise<JsonObject> {
  await loadClusterGlobalParsers(major)
  const elided: JsonObject[] = []
  const mixed: JsonObject[] = []
  const autocommit: JsonObject[] = []
  const noStatements: string[] = []
  const counts = { elided: 0, mixedDoBlocks: 0, autocommit: 0, noStatements: 0, expectations: 0 }
  const strictness = historyStrictness(files)
  for (const f of files) {
    if (skipped.has(f.stem)) continue
    const text = normalizeSqlSource(f.bytes)
    const r = text.ok ? fileReplay(major, text.value, [], strictness) : undefined
    if (r === undefined) continue
    for (const e of r.elided) {
      counts.elided++
      if (elided.length < MAX_SUMMARY_ENTRIES) {
        elided.push({ file: f.stem, statement: e.statement, form: e.form, type: e.type })
      }
    }
    for (const g of r.globals) counts.expectations += g.expectations.length
    for (const statement of r.mixedDoBlocks) {
      counts.mixedDoBlocks++
      if (mixed.length < MAX_SUMMARY_ENTRIES) mixed.push({ file: f.stem, statement })
    }
    for (const statement of r.autocommit) {
      counts.autocommit++
      if (autocommit.length < MAX_SUMMARY_ENTRIES) autocommit.push({ file: f.stem, statement })
    }
    if (r.noStatements) {
      counts.noStatements++
      if (noStatements.length < MAX_SUMMARY_ENTRIES) noStatements.push(f.stem)
    }
  }
  return { counts, elided, mixedDoBlocks: mixed, autocommit, noStatements }
}

function replayContentOf(plan: Pick<PlanRecord, 'body'>): ReplayContent {
  const c = plan.body['content'] as unknown as ReplayContent | undefined
  if (c === undefined || typeof c.reportId !== 'string' || !Array.isArray(c.files)) {
    throw new MigrationError('PLAN_STALE')
  }
  return c
}

/** Only schemas, extensions and default privileges: nothing a replay could collide with. */
function emptyDocument(doc: CanonicalDocument): boolean {
  return doc.entries.every(
    (e) => e.class === 'schema' || e.class === 'extension' || e.class === 'default_privileges',
  )
}

interface LegacyLedgerEntry {
  readonly source: 'supabase' | 'drizzle' | 'applied_migrations'
  /** The name the ledger recorded (Supabase: `name`, the file stem as applied). */
  readonly name: string
  /** Supabase only: `<version>_<name>`, a fallback name hint of older ledgers. */
  readonly altName: string | null
  /** sha256:<hex> of the file bytes (drizzle), or null. */
  readonly bytesDigest: string | null
  /** The applied statements as the ledger holds them (supabase), or null. */
  readonly statements: readonly string[] | null
  /** When the ledger says it was applied (Supabase's version, drizzle's created_at, a runner's applied_at). */
  readonly appliedAt: string | null
}

const LEDGER_PRESENT = sql`SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present`
const SUPABASE = sql`SELECT version::text AS version, coalesce(name::text, '') AS name,
       coalesce(pg_catalog.to_jsonb(statements), '[]'::jsonb) AS statements
  FROM supabase_migrations.schema_migrations ORDER BY version`
const DRIZZLE = sql`SELECT hash::text AS hash, created_at::text AS created_at
  FROM drizzle.__drizzle_migrations ORDER BY id`

/** drizzle's `created_at` (milliseconds since the epoch) as a time, if it is one. */
function drizzleTime(value: string | null): string | null {
  if (value === null || !/^[0-9]{10,15}$/.test(value)) return null
  const t = Number(value)
  return t > 946_684_800_000 && t < 32_503_680_000_000 ? new Date(t).toISOString() : null
}
const APPLIED_MIGRATIONS = sql`SELECT filename::text AS filename,
       to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS applied_at
  FROM public.applied_migrations ORDER BY applied_at`

/** The legacy ledgers the request named, as evidence; an unreadable one is reported, never assumed empty. */
async function readLegacyLedgers(
  reader: CatalogReader,
  ledgers: Hints['ledgers'],
): Promise<{ entries: LegacyLedgerEntry[]; unreadable: string[] }> {
  const entries: LegacyLedgerEntry[] = []
  const unreadable: string[] = []
  const table = {
    supabase: 'supabase_migrations.schema_migrations',
    drizzle: 'drizzle.__drizzle_migrations',
    applied_migrations: 'public.applied_migrations',
  } as const
  for (const ledger of ledgers) {
    const before = entries.length
    const read = await guarded(reader, async () => {
      const present = await reader.query(LEDGER_PRESENT, [table[ledger]])
      if (present[0]?.bool('present') !== true) return true
      if (ledger === 'supabase') {
        for (const r of await reader.query(SUPABASE)) {
          const statements = r.json('statements')
          const version = r.text('version')
          const name = r.text('name')
          const joined = [version, name].filter((x) => x !== '').join('_')
          entries.push({
            source: ledger,
            name: name === '' ? joined : name,
            altName: name === '' ? null : joined,
            bytesDigest: null,
            statements: Array.isArray(statements)
              ? statements.filter((x) => typeof x === 'string')
              : [],
            appliedAt: supabaseVersionTime(version),
          })
        }
      } else if (ledger === 'drizzle') {
        for (const r of await reader.query(DRIZZLE)) {
          entries.push({
            source: ledger,
            name: r.text('hash'),
            altName: null,
            bytesDigest: `sha256:${r.text('hash').toLowerCase()}`,
            statements: null,
            appliedAt: drizzleTime(r.textOrNull('created_at')),
          })
        }
      } else {
        for (const r of await reader.query(APPLIED_MIGRATIONS)) {
          entries.push({
            source: ledger,
            name: r.text('filename').replace(/\.sql$/, ''),
            altName: null,
            bytesDigest: null,
            statements: null,
            appliedAt: r.textOrNull('applied_at'),
          })
        }
      }
      return true
    })
    if (read === undefined) {
      // Nothing of a ledger that could not be read completely counts.
      entries.length = before
      unreadable.push(ledger)
    }
  }
  return { entries, unreadable }
}

/**
 * Runs a read under a savepoint: a refused read (a missing privilege on a
 * legacy ledger or a schema) is reported as unreadable instead of aborting
 * the transaction every later read needs.
 */
/**
 * SQLSTATE classes of a failure that may not happen again: a lost connection
 * (08), a serialization failure or deadlock (40), insufficient resources
 * (53), an object in use or a lock not available (55), a cancel, a timeout
 * or a shutdown (57), a system error (58).
 */
const TRANSIENT_CLASSES = new Set(['08', '40', '53', '55', '57', '58'])

/**
 * Whether a read that raised says something about what can be read on the
 * target (a privilege the observer lacks, a name the server refuses, a row
 * the engine cannot decode), so the same read fails the same way again: it
 * is `unreadable`. A failure that may pass on its own (the target
 * unreachable, a timeout, a lock wait, a cancel) is re-raised, so the run
 * errors and can be retried (follow-up 3 re-review).
 */
export function readsAsUnreadable(error: unknown): boolean {
  if (!(error instanceof TargetError)) return true
  if (
    error.code !== 'PERMISSION_DENIED' &&
    error.code !== 'QUERY_PARSE_ERROR' &&
    error.code !== 'TARGET_SQL_ERROR'
  ) {
    return false
  }
  return error.sqlstate === undefined || !TRANSIENT_CLASSES.has(error.sqlstate.slice(0, 2))
}

async function guarded<T>(reader: CatalogReader, fn: () => Promise<T>): Promise<T | undefined> {
  await reader.query(sql`SAVEPOINT exdb_import_read`)
  try {
    const value = await fn()
    await reader.query(sql`RELEASE SAVEPOINT exdb_import_read`)
    return value
  } catch (error) {
    if (!readsAsUnreadable(error)) throw error
    await reader.query(sql`ROLLBACK TO SAVEPOINT exdb_import_read`)
    return undefined
  }
}

interface FileAnalysis {
  readonly file: ImportFile
  readonly statements: readonly StatementFacts[]
  readonly expectations: readonly Expectation[]
  readonly surviving: readonly { readonly statement: number; readonly expectation: Expectation }[]
  readonly underived: boolean
  /** Cluster-global expectations of the elided statements (legacy-import.md §2.4). */
  readonly globals: readonly ClusterGlobalExpectation[]
  readonly survivingGlobals: readonly ClusterGlobalExpectation[]
  /** An elided statement stated something no expectation can hold. */
  readonly globalsUnknown: boolean
  readonly mixedDoBlocks: readonly number[]
  readonly noStatements: boolean
}

/** Each file's statements and, over the whole chain, the expectations that survive later files. */
function analyzeChain(
  files: readonly ImportFile[],
  replays: ReadonlyMap<string, FileReplay>,
): FileAnalysis[] | { readonly failedAt: string } {
  const perFile: FileReplay[] = []
  for (const f of files) {
    const r = replays.get(f.stem)
    if (r === undefined) return { failedAt: f.stem }
    perFile.push(r)
  }
  // One chain: statement k of file i gets a global index, survivors map back to their file.
  const flat: StatementFacts[] = []
  const owner: number[] = []
  for (const [i, r] of perFile.entries()) {
    for (const s of r.statements) {
      flat.push({ ...s, index: flat.length })
      owner.push(i)
    }
  }
  const survivors = survivingExpectations(flat)
  const globals = survivingGlobals(perFile)
  return files.map((file, i) => {
    const r = perFile[i] as FileReplay
    const elided = new Set(r.elided.map((e) => e.statement))
    return {
      file,
      statements: r.statements,
      expectations: r.statements.flatMap((s) => [...s.expectations]),
      surviving: survivors.filter((x) => owner[x.statement] === i),
      // An elided statement's effects are the cluster-global expectations, not underived SQL.
      underived: r.statements.some(
        (s) => !elided.has(s.index) && (s.procedural || s.coverage !== 'derived'),
      ),
      globals: r.globals.flatMap((g) => [...g.expectations]),
      survivingGlobals: globals.surviving[i] ?? [],
      globalsUnknown: r.globals.some((g) => g.unknown),
      mixedDoBlocks: r.mixedDoBlocks,
      noStatements: r.noStatements,
    }
  })
}

/**
 * How every file's guards are read: from the whole history, since what one
 * file creates or sets stays for the files after it (legacy-import.md §2.4).
 */
function historyStrictness(files: readonly Pick<ImportFile, 'bytes'>[]): GuardStrictness {
  return guardStrictness(
    files.flatMap((f) => {
      const text = normalizeSqlSource(f.bytes)
      return text.ok ? [text.value] : []
    }),
  )
}

/** Each file's replay (legacy-import.md §2.4); a file its major cannot read has none. */
async function replaysOf(
  major: 16 | 17 | 18,
  files: readonly ImportFile[],
  trusted: readonly string[],
): Promise<Map<string, FileReplay>> {
  await loadClusterGlobalParsers(major)
  const out = new Map<string, FileReplay>()
  const strictness = historyStrictness(files)
  for (const f of files) {
    const text = normalizeSqlSource(f.bytes)
    const r = text.ok ? fileReplay(major, text.value, trusted, strictness) : undefined
    if (r !== undefined) out.set(f.stem, r)
  }
  return out
}

interface Classified {
  readonly kind: ItemRecord['kind']
  readonly legacyId: string
  readonly name: string
  readonly state: ImportItemState
  readonly contentDigest: string | null
  readonly provenance: Provenance | null
  readonly appliedAt: string | null
  readonly evidence: readonly string[]
  readonly strength: EvidenceStrength | null
  /** The surviving expectations that did not hold (files; `null` for other items). */
  readonly failing: readonly ExpectationFailure[] | null
}

/** How many of an item's failing expectations the report shows (all are kept). */
const FAILING_SHOWN = 20

/** At most this many evidence entries per item; a longer list says so in its last entry. */
const MAX_EVIDENCE = 16

/** The evidence list of an item: never cut silently (Wave 9 order A3). */
export function cappedEvidence(evidence: readonly string[]): string[] {
  const unique = [...new Set(evidence)]
  return unique.length <= MAX_EVIDENCE
    ? unique
    : [...unique.slice(0, MAX_EVIDENCE - 1), `evidence_truncated:${unique.length}`]
}

/** What a ledger entry says about one file, with its strength (legacy-import.md §2.3). */
interface Related {
  readonly strength: EvidenceStrength
  readonly provenance: Provenance | null
  readonly appliedAt: string | null
  readonly evidence: string
}

function provenanceOf(match: ContentMatch): Provenance | null {
  switch (match.how) {
    case 'hash':
      return 'legacy_tool_hash'
    case 'alias':
      return 'legacy_file_at_import'
    case 'name_hint':
    case 'alias_contradicted':
      return null
    default:
      return 'legacy_applied_statements'
  }
}

/**
 * The evidence of every ledger entry for every file, strongest per pair
 * (legacy-import.md §2.3): a tool's hash of the bytes; the applied
 * statements against the file's statements (exact, normalized, or with
 * comments inside bodies ignored); a curated alias, also for one entry that
 * stands for several files (then the entry's statements are compared with
 * the files' statements joined in file order, and an entry whose statements
 * differ from them contradicts the alias: `alias_contradicted`, weak); the
 * name. A numeric prefix
 * is never evidence. Keys are computed once per side.
 *
 * Content proves that one file ran, never which of several files with the
 * same content, and each ledger records a file once. An entry whose name is
 * a file's stem stands for that file only: its content records it when it
 * matches, and never another file (a copy, or the text the named file had
 * when it ran: `content_names_other_file`). The unnamed entries of one ledger
 * whose content equals the same files pair up with them in file and ledger
 * order when there are at least as many entries as files (an entry beyond
 * them stays without a file); otherwise none is recorded by that content and
 * each file is `contested` (the number of files sharing it): a person decides.
 */
function relateLedger(
  chain: readonly FileAnalysis[],
  ledger: readonly LegacyLedgerEntry[],
  hints: Hints,
): {
  related: Map<string, Related[]>
  used: Set<LegacyLedgerEntry>
  contested: Map<string, number>
  contradicted: Set<string>
  namesOther: Set<string>
} {
  const related = new Map<string, Related[]>()
  const used = new Set<LegacyLedgerEntry>()
  const contested = new Map<string, number>()
  const contradicted = new Set<string>()
  const namesOther = new Set<string>()
  const keys = new Map<string, ContentKeys>()
  const statementsOf = new Map<string, string[]>()
  const textOf = new Map<string, string>()
  const byExact = new Map<string, string[]>()
  const byNormalized = new Map<string, string[]>()
  const byBodies = new Map<string, string[]>()
  const byDigest = new Map<string, string[]>()
  const push = (m: Map<string, string[]>, k: string | null, stem: string) => {
    if (k !== null) m.set(k, [...(m.get(k) ?? []), stem])
  }
  for (const a of chain) {
    const stem = a.file.stem
    const text = normalizeSqlSource(a.file.bytes)
    const value = text.ok ? text.value : ''
    const statements = a.statements.map((st) => value.slice(st.start, st.end))
    const k = contentKeys(statements, [value])
    keys.set(stem, k)
    statementsOf.set(stem, statements)
    textOf.set(stem, value)
    push(byExact, k.exact, stem)
    push(byNormalized, k.normalized, stem)
    push(byBodies, k.bodies, stem)
    push(byDigest, a.file.bytesDigest, stem)
  }
  const position = new Map(chain.map((a, i) => [a.file.stem, i]))
  const groups = new Map<string, string[]>()
  for (const [name, value] of Object.entries(hints.aliases)) {
    const stems = (typeof value === 'string' ? [value] : [...value]).filter((s) => keys.has(s))
    groups.set(
      name,
      stems.sort((x, y) => (position.get(x) ?? 0) - (position.get(y) ?? 0)),
    )
  }
  const add = (stem: string, e: LegacyLedgerEntry, match: ContentMatch) => {
    used.add(e)
    related.set(stem, [
      ...(related.get(stem) ?? []),
      {
        strength: match.strength,
        provenance: provenanceOf(match),
        appliedAt: e.appliedAt,
        evidence: `${e.source}:${match.how}`,
      },
    ])
  }
  // Each ledger records a file once: what one entry took, no other entry of the same ledger
  // takes. Unnamed entries wait until every named one is placed, then pair per content.
  const taken = new Map<string, Set<string>>()
  const takenBy = (source: string) => {
    const set = taken.get(source) ?? new Set<string>()
    taken.set(source, set)
    return set
  }
  const unnamed = new Map<
    string,
    { stems: string[]; entries: { entry: LegacyLedgerEntry; matches: Map<string, ContentMatch> }[] }
  >()
  for (const e of ledger) {
    // Every file the entry's content equals, at the strongest tier for that file.
    const matches = new Map<string, ContentMatch>()
    const offer = (stems: readonly string[], match: ContentMatch) => {
      for (const stem of stems) if (!matches.has(stem)) matches.set(stem, match)
    }
    if (e.bytesDigest !== null) {
      offer(byDigest.get(e.bytesDigest) ?? [], { strength: 'strong', how: 'hash' })
    }
    const applied = e.statements !== null && e.statements.length > 0 ? e.statements : null
    const entryKeys = applied === null ? null : contentKeys(applied, applied)
    if (entryKeys !== null) {
      const tiers: [Map<string, string[]>, string | null, ContentMatch][] = [
        [byExact, entryKeys.exact, { strength: 'strong', how: 'statements' }],
        [byNormalized, entryKeys.normalized, { strength: 'medium', how: 'statements_normalized' }],
        [byBodies, entryKeys.bodies, { strength: 'medium', how: 'statements_bodies' }],
      ]
      for (const [index, key, match] of tiers)
        offer(key === null ? [] : (index.get(key) ?? []), match)
    }
    if (matches.size > 0) {
      const named = [e.name, e.altName].find((n): n is string => n !== null && keys.has(n))
      const mine = takenBy(e.source)
      if (named !== undefined) {
        // An entry that names a file stands for that file only: its content records it when
        // it matches, and never another file of the same content (a copy, an older text).
        const match = matches.get(named)
        if (match !== undefined && !mine.has(named)) {
          add(named, e, match)
          mine.add(named)
        } else {
          used.add(e)
          for (const stem of matches.keys()) if (stem !== named) namesOther.add(stem)
        }
      } else {
        const stems = [...matches.keys()].sort(
          (x, y) => (position.get(x) ?? 0) - (position.get(y) ?? 0),
        )
        const key = `${e.source}\u0000${stems.join('\u0000')}`
        const group = unnamed.get(key) ?? { stems, entries: [] }
        group.entries.push({ entry: e, matches })
        unnamed.set(key, group)
      }
    }
    const group = groups.get(e.name) ?? (e.altName === null ? undefined : groups.get(e.altName))
    if (group !== undefined && group.length > 0) {
      const joined =
        entryKeys === null
          ? null
          : matchKeys(
              entryKeys,
              contentKeys(
                group.flatMap((s) => statementsOf.get(s) ?? []),
                group.map((s) => textOf.get(s) ?? ''),
              ),
            )
      if (joined === null && entryKeys !== null) {
        // The entry holds statements, and they are not the files' joined content: the alias
        // is contradicted, so it records none of them; a person decides.
        for (const stem of group) {
          add(stem, e, { strength: 'weak', how: 'alias_contradicted' })
          contradicted.add(stem)
        }
      } else {
        for (const stem of group) add(stem, e, joined ?? { strength: 'curated', how: 'alias' })
      }
    }
    for (const name of new Set([e.name, e.altName])) {
      if (name !== null && keys.has(name)) add(name, e, { strength: 'weak', how: 'name_hint' })
    }
  }
  for (const { stems, entries } of unnamed.values()) {
    const source = entries[0]?.entry.source ?? 'supabase'
    const mine = takenBy(source)
    const open = stems.filter((stem) => !mine.has(stem))
    if (entries.length >= open.length) {
      // As many entries as files: each ran, in file order and ledger order. An entry beyond
      // the files (one whose file was deleted, or a second run) stays without a file.
      open.forEach((stem, i) => {
        const c = entries[i]
        const match = c?.matches.get(stem)
        if (c !== undefined && match !== undefined) {
          add(stem, c.entry, match)
          mine.add(stem)
        }
      })
    } else {
      for (const c of entries) used.add(c.entry)
      for (const stem of open) contested.set(stem, Math.max(contested.get(stem) ?? 0, stems.length))
    }
  }
  return { related, used, contested, contradicted, namesOther }
}

/** Classifies each file (legacy-import.md §2 step 4); evidence by content first, names last. */
async function classify(
  reader: CatalogReader,
  chain: readonly FileAnalysis[],
  ledger: readonly LegacyLedgerEntry[],
  unreadable: readonly string[],
  hints: Hints,
  searchPath: readonly string[],
): Promise<Classified[]> {
  const out: Classified[] = []
  const { related, used, contested, contradicted, namesOther } = relateLedger(chain, ledger, hints)
  for (const a of chain) {
    const stem = a.file.stem
    const evidence: string[] = unreadable.map((l) => `ledger_unreadable:${l}`)
    if (hints.notApplicable.includes(stem)) {
      out.push({
        kind: 'file',
        legacyId: `legacy:${stem}`,
        name: stem,
        state: 'not_applicable',
        contentDigest: a.file.sourceDigest,
        provenance: null,
        appliedAt: null,
        evidence: ['hint:not_applicable'],
        strength: null,
        failing: null,
      })
      continue
    }
    // Ledger evidence, strongest first; a name alone never records a file.
    const rel = [...(related.get(stem) ?? [])].sort(
      (x, y) => STRENGTH_RANK[y.strength] - STRENGTH_RANK[x.strength],
    )
    evidence.push(...rel.map((r) => r.evidence))
    const best = rel[0]
    const strength = best?.strength ?? null
    const recorded = recordsTheFile(strength)
    const provenance: Provenance | null = recorded ? (best?.provenance ?? null) : null
    // The earliest time a ledger that records the file names.
    const appliedAt =
      rel
        .filter((r) => recordsTheFile(r.strength) && r.appliedAt !== null)
        .map((r) => r.appliedAt as string)
        .sort()[0] ?? null
    // Effects: the file's surviving expectations on the imported target, structural and
    // cluster-global (legacy-import.md §2.4).
    let state: ImportItemState
    const failing: ExpectationFailure[] = []
    if (a.noStatements) {
      evidence.push('no_statements')
      state = recorded ? 'recorded_present' : 'unrecorded_present'
    } else if (a.expectations.length === 0 && a.globals.length === 0) {
      evidence.push(a.underived ? 'effects_not_derivable' : 'no_structural_expectations')
      state = recorded ? 'recorded_present' : 'ambiguous'
    } else if (a.surviving.length === 0 && a.survivingGlobals.length === 0) {
      evidence.push('expectations_superseded')
      state = 'superseded'
    } else {
      let held = 0
      let total = 0
      let unreadable = false
      if (a.surviving.length > 0) {
        const results = await guarded(reader, async () => {
          await pinSearchPath(reader, searchPath)
          return checkExpectations(reader, a.surviving)
        })
        if (results === undefined) {
          evidence.push('expectations_unreadable')
          failing.push(unreadableFailure(stem, 'structural'))
          unreadable = true
        } else {
          const ok = results.filter((r) => r.ok).length
          evidence.push(`expectations_held:${ok}/${results.length}`)
          failing.push(...structuralFailures(stem, results))
          held += ok
          total += results.length
        }
      }
      let globalsHold = true
      if (a.survivingGlobals.length > 0) {
        const results = await guarded(reader, () =>
          checkClusterGlobalExpectations(reader, a.survivingGlobals),
        )
        if (results === undefined) {
          evidence.push('cluster_global_unreadable')
          failing.push(unreadableFailure(stem, 'cluster_global'))
          unreadable = true
          globalsHold = false
        } else {
          // A guarded statement whose guard does not hold on the target states nothing there.
          const applied = results.filter((r) => r.applies)
          const unmet = results.length - applied.length
          if (unmet > 0) evidence.push(`cluster_global_guard_unmet:${unmet}`)
          const ok = applied.filter((r) => r.ok).length
          if (applied.length > 0) evidence.push(`cluster_global_held:${ok}/${applied.length}`)
          failing.push(...clusterGlobalFailures(stem, results))
          globalsHold = ok === applied.length
          held += ok
          total += applied.length
        }
      }
      if (unreadable || (held > 0 && held < total)) {
        state = 'ambiguous'
      } else if (total === 0) {
        // Every expectation sat behind a guard that does not hold: nothing was checked.
        state = recorded ? 'recorded_present' : 'ambiguous'
      } else if (held === total) {
        state = recorded ? 'recorded_present' : 'unrecorded_present'
      } else {
        state = recorded ? 'recorded_missing' : 'unrecorded_missing'
      }
      if (a.underived && state !== 'ambiguous') {
        evidence.push('partly_derived')
        if (state === 'unrecorded_present') state = 'ambiguous'
      }
      // Role effects are cluster-wide (another database may have changed them): a file whose
      // cluster-global effects do not all hold is never present nor missing; a person decides.
      if (!globalsHold) state = 'ambiguous'
    }
    if (a.globalsUnknown) {
      // A role effect not derivable from the text is never checked: superseded objects do not
      // supersede it (legacy-import.md §2.4).
      evidence.push('cluster_global_unknown')
      state = 'ambiguous'
    }
    for (const statement of a.mixedDoBlocks) {
      evidence.push(`do_block_mixed:${statement}`)
      state = 'ambiguous'
    }
    // Ledger content that several files share, held by fewer entries than files: it proves
    // that some of them ran, not that this one did.
    const sharing = contested.get(stem)
    if (sharing !== undefined && !recorded) {
      evidence.push(`content_matches_files:${sharing}`)
      state = 'ambiguous'
    }
    // An alias the entry's own statements contradict records nothing.
    if (contradicted.has(stem) && !recorded) state = 'ambiguous'
    // An entry that names another file holds this file's content: a copy, or the text the
    // named file had when it ran. Neither ran by this evidence; a person decides.
    if (namesOther.has(stem) && !recorded) {
      evidence.push('content_names_other_file')
      state = 'ambiguous'
    }
    out.push({
      kind: 'file',
      legacyId: `legacy:${stem}`,
      name: stem,
      state,
      contentDigest: a.file.sourceDigest,
      provenance:
        state === 'recorded_present' || state === 'unrecorded_present' || state === 'superseded'
          ? (provenance ?? 'legacy_file_at_import')
          : null,
      appliedAt: recorded ? appliedAt : null,
      evidence: cappedEvidence(evidence),
      strength,
      failing,
    })
  }
  for (const e of ledger) {
    if (used.has(e)) continue
    // A Supabase name may repeat across versions; `<version>_<name>` is unique.
    const id = e.altName ?? e.name
    out.push({
      kind: 'ledger_entry',
      legacyId: `ledger:${e.source}:${id}`.slice(0, 200),
      name: id.slice(0, 200) || e.source,
      state: 'ambiguous',
      contentDigest: null,
      provenance: null,
      appliedAt: e.appliedAt,
      evidence: ['ledger_entry_without_file'],
      strength: null,
      failing: null,
    })
  }
  return out
}

const MAX_DRIFT_ITEMS = 500

/**
 * Global drift between the replay and the target: objects no legacy file
 * explains. At most {@link MAX_DRIFT_ITEMS} become items; the true number is
 * returned with them, and a report that holds fewer is never baselined.
 */
function driftItems(
  replay: CanonicalDocument,
  target: CanonicalDocument,
): { readonly items: Classified[]; readonly total: number } {
  const diff = diffDocuments(replay, target)
  const key = (e: { class: string; key: readonly string[] }) => `${e.class}:${e.key.join('.')}`
  const out: Classified[] = []
  for (const e of diff.added) {
    out.push({
      kind: 'drift',
      legacyId: `drift:${key(e)}`.slice(0, 200),
      name: key(e).slice(0, 200),
      state: 'ambiguous',
      contentDigest: null,
      provenance: null,
      appliedAt: null,
      evidence: ['only_in_target'],
      strength: null,
      failing: null,
    })
  }
  for (const e of diff.removed) {
    out.push({
      kind: 'drift',
      legacyId: `drift:${key(e)}`.slice(0, 200),
      name: key(e).slice(0, 200),
      state: 'ambiguous',
      contentDigest: null,
      provenance: null,
      appliedAt: null,
      evidence: ['only_in_replay'],
      strength: null,
      failing: null,
    })
  }
  for (const c of diff.changed) {
    out.push({
      kind: 'drift',
      legacyId: `drift:${key(c)}`.slice(0, 200),
      name: key(c).slice(0, 200),
      state: 'ambiguous',
      contentDigest: null,
      provenance: null,
      appliedAt: null,
      evidence: cappedEvidence(['differs', ...c.attributes.map((a) => `attribute:${a}`)]),
      strength: null,
      failing: null,
    })
  }
  return { items: out.slice(0, MAX_DRIFT_ITEMS), total: out.length }
}

/** The worker's replay and comparison (`migration.import.replay`). */
export class ImportReplayKind implements OperationKind {
  readonly kind = 'migration.import.replay'
  readonly version = 1
  readonly actionClass = 'standard' as const
  readonly verifies = true
  readonly #deps: MigrationKindDeps

  constructor(deps: MigrationKindDeps) {
    this.#deps = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${replayContentOf(plan).scratch.targetId}:schema`]
    } catch {
      return []
    }
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let c: ReplayContent
    try {
      c = replayContentOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    const target = await findTarget(this.#deps.store, c.target.targetId)
    const scratch = await findTarget(this.#deps.store, c.scratch.targetId)
    const changed: ChangedBinding[] = []
    if (
      target === undefined ||
      target.state !== 'active' ||
      target.generation !== c.target.generation
    ) {
      changed.push({ binding: 'target', actual: target?.state ?? 'missing' })
    }
    if (
      scratch === undefined ||
      scratch.state !== 'active' ||
      scratch.generation !== c.scratch.generation
    ) {
      changed.push({ binding: 'scratch', actual: scratch?.state ?? 'missing' })
    }
    const report = await readReport(this.#deps.store, c.reportId)
    if (report?.state !== 'pending') {
      changed.push({ binding: 'report', actual: report?.state ?? 'missing' })
    }
    // The alias still names the role the plan checked in the scratch environment, and the
    // exception it relied on still holds (a plan without the check is stale).
    if (scratch !== undefined) {
      const resolved = await executionRolesFor(this.#deps.store, scratch)
      if (
        c.executionRoleCheck === undefined ||
        resolved.roles[c.executionRoleAlias ?? 'owner'] !== c.executionRole
      ) {
        changed.push({ binding: 'execution_roles', actual: 'changed' })
      }
      if (!boundExceptionsHold(c.executionRoleExceptions, resolved.exceptions)) {
        changed.push({ binding: 'execution_role_exception', actual: 'changed' })
      }
    }
    return changed
  }

  async #finish(
    fence: Fence,
    reportId: string,
    result:
      | { readonly state: 'incomplete'; readonly reason: string }
      | {
          readonly state: 'open'
          readonly fingerprint: string
          readonly replayFingerprint: string
          readonly items: readonly Classified[]
          readonly driftTotal: number
          readonly driftHeld: number
        },
    operationId: string,
  ): Promise<void> {
    await fenced(fence, 'migrations.import.finish', async (tx) => {
      if (result.state === 'incomplete') {
        await tx.query(
          'migrations.import.incomplete',
          `UPDATE migrations.import_reports
              SET state = 'incomplete', incomplete_reason = $2, operation_id = $3,
                  analyzed_at = clock_timestamp()
            WHERE report_id = $1 AND state = 'pending'`,
          [reportId, result.reason.slice(0, 200), operationId],
        )
        return
      }
      for (const [i, item] of result.items.entries()) {
        await tx.query(
          'migrations.import.item',
          `INSERT INTO migrations.import_items
             (report_id, item_id, kind, legacy_id, name, state, content_digest, checksum_provenance,
              applied_at, evidence, evidence_strength, failing)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::jsonb)`,
          [
            reportId,
            i + 1,
            item.kind,
            item.legacyId,
            item.name,
            item.state,
            item.contentDigest,
            item.provenance,
            item.appliedAt,
            JSON.stringify(item.evidence),
            item.strength,
            item.failing === null ? null : JSON.stringify(item.failing),
          ],
        )
      }
      await tx.query(
        'migrations.import.open',
        `UPDATE migrations.import_reports
            SET state = 'open', fingerprint = $2, replay_fingerprint = $3, operation_id = $4,
                analyzed_at = clock_timestamp(), drift_total = $5, drift_truncated = $6
          WHERE report_id = $1 AND state = 'pending'`,
        [
          reportId,
          result.fingerprint,
          result.replayFingerprint,
          operationId,
          result.driftTotal,
          result.driftHeld < result.driftTotal,
        ],
      )
    })
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = replayContentOf(ctx.plan)
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    const target = await findTarget(this.#deps.store, c.target.targetId)
    const scratch = await findTarget(this.#deps.store, c.scratch.targetId)
    const files = await readFiles(this.#deps.store, c.reportId)
    if (
      target === undefined ||
      scratch === undefined ||
      files.length !== c.files.length ||
      files.some((f, i) => f.stem !== c.files[i]?.stem || f.checksum !== c.files[i]?.checksum)
    ) {
      return { outcome: 'not_applied', errorCode: 'PLAN_STALE' }
    }
    const project = await projectRegistry(this.#deps.store, c.projectId)
    const opened = await this.#deps.connector.forTarget(scratch, 'migrator', ctx.operationId)
    const session = opened.session
    let release: (() => Promise<void>) | undefined
    try {
      try {
        release = await takeTargetLock(session, scratch.targetId, 'schema', {
          deadlineMs: 30_000,
          signal: ctx.signal,
        })
      } catch (error) {
        if (error instanceof LockUnavailable) {
          return { outcome: 'not_applied', errorCode: 'MIGRATION_LOCK_TIMEOUT' }
        }
        throw error
      }
      // The execution role again, on the migrator session under the lock: still usable, and
      // BYPASSRLS excused only where the plan bound an exception that still holds.
      const resolved = await executionRolesFor(this.#deps.store, scratch)
      const [roleFacts] = await executionRoleFacts(session.reader(), [c.executionRole])
      const roleProblem =
        c.executionRoleAlias === undefined ||
        resolved.roles[c.executionRoleAlias] !== c.executionRole
          ? 'alias_changed'
          : roleFacts === undefined
            ? 'missing'
            : !boundExceptionsHold(c.executionRoleExceptions, resolved.exceptions)
              ? 'exception_changed'
              : rolesStillUsable([roleFacts], c.executionRoleExceptions)
                ? null
                : (executionRoleProblem(roleFacts) ?? 'changed')
      if (roleProblem !== null) {
        await this.#finish(
          fence,
          c.reportId,
          { state: 'incomplete', reason: `execution_role:${roleProblem}` },
          ctx.operationId,
        )
        return {
          outcome: 'not_applied',
          errorCode: 'PLAN_STALE',
          detail: { changedBindings: ['execution_roles'] },
        }
      }
      const major = session.facts.major
      await loadParser(major)
      const scope = project.scope
      const replays = await replaysOf(major, files, project.trustedExtensions)
      // The scratch target is empty: nothing a replay could collide with or be mistaken for.
      const before = await session.readOnly(async (rtx) => ({
        snapshot: await snapshotWithin(rtx, scopeOf(scope)),
        ledger: await readLedgerRows(rtx),
      }))
      if (!emptyDocument(before.snapshot.document) || before.ledger.length > 0) {
        await this.#finish(
          fence,
          c.reportId,
          { state: 'incomplete', reason: 'scratch_not_empty' },
          ctx.operationId,
        )
        return { outcome: 'not_applied', errorCode: 'PRECONDITION_FAILED' }
      }
      // The same major, and extensions declared on the scratch target, never guessed: each
      // must be installed there in the same schema and version as on the imported target, or
      // every object that uses one would differ (legacy-import.md §2, §6).
      let differs: string | null
      try {
        differs = await scratchDiffers(this.#deps, target, session)
      } catch (error) {
        if (!unavailable(error)) throw error
        // Nothing ran: the report says why instead of staying pending (legacy-import.md §6).
        await this.#finish(
          fence,
          c.reportId,
          { state: 'incomplete', reason: 'target_unavailable' },
          ctx.operationId,
        )
        return { outcome: 'not_applied', errorCode: 'TARGET_UNAVAILABLE' }
      }
      if (differs !== null) {
        await this.#finish(
          fence,
          c.reportId,
          { state: 'incomplete', reason: differs },
          ctx.operationId,
        )
        return { outcome: 'not_applied', errorCode: 'PRECONDITION_FAILED' }
      }
      // Files of another project or target are neither replayed nor compared.
      const skipped = new Set(c.hints.notApplicable)
      const applicable = files.filter((f) => !skipped.has(f.stem))
      for (const f of applicable) {
        const plan = replays.get(f.stem)
        // A file its major cannot read runs as submitted: the admission refuses it as before.
        const segments =
          plan === undefined
            ? [{ kind: 'transactional' as const, statements: [] as number[], bytes: f.bytes }]
            : plan.segments.map((g) => ({ ...g, bytes: new TextEncoder().encode(g.text) }))
        for (const segment of segments) {
          if (!(await leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner))) {
            throw new LeaseLost()
          }
          const input = {
            session,
            content: {
              target: {
                targetId: scratch.targetId,
                generation: c.scratch.generation,
                clusterSystemIdentifier: c.scratch.clusterSystemIdentifier,
              },
            } as unknown as PlanContent,
            item: {
              migrationId: f.stem,
              executionRole: c.executionRole,
              searchPath: c.searchPath,
              lockTimeoutMs: 5000,
              statementTimeoutMs: 900_000,
            } as unknown as PlanItem,
            revision: {
              files: { 'up.sql': segment.bytes, 'verify.sql': null, 'down.sql': null },
            } as unknown as StoredRevision,
            operationId: ctx.operationId,
            planId: ctx.plan.planId,
            actorRef: ctx.plan.actor.identityId,
            clientRef: ctx.plan.actor.clientId,
            installationId: this.#deps.installationId,
            engineVersion: this.#deps.engineVersion,
            scope,
            trustedExtensions: project.trustedExtensions,
            fingerprintBefore: null,
            stillHolds: () => leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner),
            replay: true as const,
          }
          const step =
            segment.kind === 'autocommit'
              ? await runReplayAutocommit(input)
              : await runTransactional(input)
          if (step.result !== 'applied') {
            // The statement's index in the file, not in the segment.
            const index =
              step.result === 'failed' && step.statementIndex !== null
                ? (segment.statements[step.statementIndex] ?? step.statementIndex)
                : null
            const detail =
              step.result === 'failed'
                ? `replay_failed:${f.stem}:${step.errorCode}${index === null ? '' : `:${index}`}${step.sqlstate === null ? '' : `:${step.sqlstate}`}`
                : `replay_unknown:${f.stem}`
            await this.#finish(
              fence,
              c.reportId,
              { state: 'incomplete', reason: detail },
              ctx.operationId,
            )
            // The scratch target took the files before this one: the replay itself happened.
            return 'applied'
          }
        }
      }
      const replay = await session.readOnly((rtx) => snapshotWithin(rtx, scopeOf(scope)))
      try {
        // The imported target is only read.
        const observed = await this.#deps.connector.forTarget(
          target,
          'observer',
          `import/${ctx.operationId}`,
        )
        try {
          const result = await observed.session.readOnly(
            async (rtx) => {
              const snapshot = await snapshotWithin(rtx, scopeOf(scope))
              const chain = analyzeChain(applicable, replays)
              if ('failedAt' in chain) return { failedAt: chain.failedAt } as const
              const ledgers = await readLegacyLedgers(rtx, c.hints.ledgers)
              const classified = await classify(
                rtx,
                chain,
                ledgers.entries,
                ledgers.unreadable,
                c.hints,
                c.searchPath,
              )
              // In file order: the skipped files as not applicable, then the ledger entries.
              const byStem = new Map(
                classified.filter((i) => i.kind === 'file').map((i) => [i.name, i]),
              )
              const items: Classified[] = files.map(
                (f) =>
                  byStem.get(f.stem) ?? {
                    kind: 'file',
                    legacyId: `legacy:${f.stem}`,
                    name: f.stem,
                    state: 'not_applicable',
                    contentDigest: f.sourceDigest,
                    provenance: null,
                    appliedAt: null,
                    evidence: ['hint:not_applicable'],
                    strength: null,
                    failing: null,
                  },
              )
              items.push(...classified.filter((i) => i.kind !== 'file'))
              return { snapshot, items } as const
            },
            { statementTimeoutMs: 120_000 },
          )
          if ('failedAt' in result) {
            await this.#finish(
              fence,
              c.reportId,
              { state: 'incomplete', reason: `parse_failed:${result.failedAt}` },
              ctx.operationId,
            )
            return 'applied'
          }
          const drift = driftItems(replay.document, result.snapshot.document)
          await this.#finish(
            fence,
            c.reportId,
            {
              state: 'open',
              fingerprint: result.snapshot.fingerprint,
              replayFingerprint: replay.fingerprint,
              items: [...result.items, ...drift.items],
              driftTotal: drift.total,
              driftHeld: drift.items.length,
            },
            ctx.operationId,
          )
        } finally {
          await observed.session.close()
        }
      } catch (error) {
        if (!unavailable(error)) throw error
        // The scratch target took the files; the imported one could not be read to compare.
        await this.#finish(
          fence,
          c.reportId,
          { state: 'incomplete', reason: 'target_unavailable' },
          ctx.operationId,
        )
      }
      return 'applied'
    } catch (error) {
      if (error instanceof LeaseLost) return 'unknown'
      throw error
    } finally {
      await release?.().catch(() => undefined)
      await session.close()
    }
  }

  /** The report was written (open or incomplete with its reason). */
  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const report = await readReport(this.#deps.store, replayContentOf(ctx.plan).reportId)
    if (report?.state === 'open') return 'passed'
    if (report?.state === 'incomplete') return 'failed'
    return 'error'
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const report = await readReport(this.#deps.store, replayContentOf(ctx.plan).reportId)
    // An interrupted replay left the scratch target part-way: a person re-creates it.
    return report === undefined || report.state === 'pending' ? 'unknown' : 'applied'
  }
}

/**
 * Why the scratch target cannot stand for the imported one, or null: another
 * PostgreSQL major (`major_differs:<target>/<scratch>`), or an extension in
 * another schema or version (`extensions_differ:<name>`). The replay runs
 * and parses on the scratch target's major, the verification on the imported
 * target's: they must be the same (legacy-import.md §2 step 2).
 */
async function scratchDiffers(
  deps: MigrationKindDeps,
  target: TargetRecord,
  scratch: TargetSession,
): Promise<string | null> {
  const observed = await deps.connector.forTarget(target, 'observer', 'import/extensions')
  let theirs: Awaited<ReturnType<typeof extensionPlacements>>
  const major = observed.session.facts.major
  try {
    theirs = await observed.session.readOnly((rtx) => extensionPlacements(rtx))
  } finally {
    await observed.session.close()
  }
  if (major !== scratch.facts.major) return `major_differs:${major}/${scratch.facts.major}`
  const ours = await scratch.readOnly((rtx) => extensionPlacements(rtx))
  for (const name of [...new Set([...theirs.keys(), ...ours.keys()])].sort()) {
    const a = theirs.get(name)
    const b = ours.get(name)
    if (a === undefined || b === undefined || a.schema !== b.schema || a.version !== b.version) {
      return `extensions_differ:${name.slice(0, 63)}`
    }
  }
  return null
}

/** A target that could not be reached or read (never a refusal of a statement). */
const unavailable = (error: unknown) =>
  error instanceof TargetError && error.code === 'TARGET_UNAVAILABLE'

function scopeOf(scope: ManagedScope) {
  return {
    ...(scope.includeSchemas === undefined ? {} : { includeSchemas: [...scope.includeSchemas] }),
    excludeSchemas: [...(scope.excludeSchemas ?? [])],
  }
}

// ----- review -----

/** `migration.import.decide`: a person resolves one item of an open report, with a note. */
export async function decideImportItem(
  tx: Tx,
  input: {
    readonly targetId: string
    readonly reportId: string
    readonly itemId: number
    readonly state: Exclude<ImportItemState, 'ambiguous'>
    readonly note: string
    readonly identityId: string
  },
) {
  const report = await readReport(tx, input.reportId)
  if (report === undefined || report.targetId !== input.targetId) {
    throw new MigrationError('NOT_FOUND')
  }
  if (report.state !== 'open') throw new MigrationError('CONFLICT')
  const { rowCount } = await tx.query(
    'migrations.import.decide',
    `UPDATE migrations.import_items
        SET decision_state = $3, decision_note = $4, decided_at = clock_timestamp(), decided_by = $5
      WHERE report_id = $1 AND item_id = $2`,
    [input.reportId, input.itemId, input.state, input.note, input.identityId],
  )
  if (rowCount !== 1) throw new MigrationError('NOT_FOUND')
  return importReportView(tx, input.targetId, input.reportId)
}

// ----- baseline -----

interface BaselineRow {
  readonly migrationId: string
  readonly name: string
  readonly checksum: string
  readonly provenance: Provenance
  readonly sourceDigest: string
  readonly appliedAt: string | null
  readonly surviving: boolean
}

interface BaselineContent {
  readonly reportId: string
  readonly reportDigest: string
  readonly projectId: string
  readonly baselineId: string
  readonly target: ReplayContent['target']
  readonly expectedState: { readonly schemaFingerprint: string; readonly ledgerStateHash: string }
  readonly rows: readonly BaselineRow[]
  readonly searchPath: readonly string[]
  readonly notApplicable: readonly string[]
}

function baselineContentOf(plan: Pick<PlanRecord, 'body'>): BaselineContent {
  const c = plan.body['content'] as unknown as BaselineContent | undefined
  if (c === undefined || typeof c.reportId !== 'string' || !Array.isArray(c.rows)) {
    throw new MigrationError('PLAN_STALE')
  }
  return c
}

/** The digest of the reviewed report: files, items and decisions (the baseline row's checksum). */
function reportDigest(files: readonly ImportFile[], items: readonly ItemRecord[]): string {
  const bytes = canonicalBytes({
    files: files.map((f) => ({ stem: f.stem, checksum: f.checksum })),
    items: items.map((i) => ({
      legacyId: i.legacyId,
      state: i.state,
      decision: i.decision === null ? null : { state: i.decision.state, note: i.decision.note },
      // What an accepting decision excuses is part of what was reviewed (follow-up 3, F1). An
      // item analyzed before it was recorded keeps the digest it had.
      ...(i.failing === null ? {} : { failing: i.failing.map((f) => ({ ...f })) }),
    })),
  })
  return bytes.ok ? `sha256:${sha256Hex(bytes.value)}` : 'sha256:unreadable'
}

/** `migration.baseline.plan`: a resolved report becomes the target's baseline. */
export async function planBaseline(
  tx: Tx,
  ctx: MigrationPlanContext,
  actor: RegistryActor,
  targetRef: string,
  reportId: string,
): Promise<PlanRecord> {
  const target = await findTarget(tx, targetRef)
  if (target === undefined) throw new MigrationError('TARGET_NOT_FOUND')
  if (target.state !== 'active' || target.placement === null) {
    throw new MigrationError('TARGET_UNAVAILABLE')
  }
  const report = await readReport(tx, reportId)
  if (report === undefined || report.targetId !== target.targetId) {
    throw new MigrationError('NOT_FOUND')
  }
  if (report.state !== 'open' || report.fingerprint === null) throw new MigrationError('CONFLICT')
  const items = await readItems(tx, reportId)
  if (report.driftTruncated || report.driftTotal === null) {
    // Drift the report does not hold was never shown to anyone: no baseline over it. A report
    // analyzed before drift totals were kept may have been cut at 500 items without a mark.
    throw new MigrationError('LEGACY_IMPORT_TRUNCATED', {
      driftTotal: report.driftTotal,
      held: items.filter((i) => i.kind === 'drift').length,
    })
  }
  // A file analyzed before failures were recorded: its acceptance would excuse whatever fails
  // (the legacy rule of Step 7); only a baseline recorded before keeps that rule.
  const unrecorded = items.filter(
    (i) => i.kind === 'file' && i.failing === null && i.state !== 'not_applicable',
  ).length
  if (unrecorded > 0) {
    throw new MigrationError('LEGACY_IMPORT_ANALYSIS_OUTDATED', { items: unrecorded })
  }
  const unresolved = unresolvedOf(items)
  if (unresolved.length > 0) {
    throw new MigrationError('LEGACY_IMPORT_AMBIGUOUS', {
      items: unresolved.slice(0, 1000).map((i) => ({ itemId: String(i.itemId) })),
      ...(unresolved.length > 1000 ? { total: unresolved.length } : {}),
    })
  }
  const files = await readFiles(tx, reportId)
  const project = await projectRegistry(tx, target.projectId)
  const opened = await ctx.connector.forTarget(
    target,
    'observer',
    `baseline-plan/${target.targetId}`,
  )
  let state: { fingerprint: string; ledgerStateHash: string; baselineId: string | null }
  try {
    state = await opened.session.readOnly(async (rtx) => {
      const meta = await readLedgerMeta(rtx)
      const rows = await readLedgerRows(rtx)
      const snapshot = await snapshotWithin(rtx, scopeOf(project.scope))
      return {
        fingerprint: snapshot.fingerprint,
        ledgerStateHash: ledgerHashOf(rows, meta?.baselineId ?? null),
        baselineId: meta?.baselineId ?? null,
      }
    })
  } finally {
    await opened.session.close()
  }
  if (state.baselineId !== null) throw new MigrationError('CONFLICT')
  if (state.fingerprint !== report.fingerprint) {
    // The target changed since the analysis: analyze again.
    throw new MigrationError('SCHEMA_FINGERPRINT_MISMATCH')
  }
  const byStem = new Map(files.map((f) => [f.stem, f]))
  const rows: BaselineRow[] = []
  for (const item of items) {
    if (item.kind !== 'file' || !APPLIED.has(effective(item))) continue
    const file = byStem.get(item.name)
    if (file === undefined) continue
    rows.push({
      migrationId: `legacy:${file.stem}`,
      name: file.stem,
      checksum: file.checksum,
      provenance: item.provenance ?? (item.decision !== null ? 'legacy_file_at_import' : 'unknown'),
      sourceDigest: file.sourceDigest,
      appliedAt: item.appliedAt,
      // The classification saw its effects hold (a person's acceptance is checked on verify too).
      surviving: item.state !== 'superseded',
    })
  }
  const content: BaselineContent = {
    reportId,
    reportDigest: reportDigest(files, items),
    projectId: target.projectId,
    baselineId: report.baselineId,
    target: {
      targetId: target.targetId,
      path: target.path,
      tier: target.tier,
      generation: target.generation,
      clusterSystemIdentifier: target.placement.systemIdentifier ?? '',
    },
    expectedState: { schemaFingerprint: state.fingerprint, ledgerStateHash: state.ledgerStateHash },
    rows,
    searchPath: [...hintsOf(report).searchPath],
    notApplicable: [...hintsOf(report).notApplicable],
  }
  const policy = await evaluateRegistryPolicy(tx, ctx.policy, {
    kind: 'migration.baseline',
    actor,
    subject: {
      productId: target.productId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      targetId: target.targetId,
      tier: target.tier,
    },
    content: content as unknown as JsonObject,
  })
  return createPlan(
    tx,
    {
      kind: 'migration.baseline',
      kindVersion: 1,
      actionClass: 'high',
      actor: operationActor(actor),
      subject: {
        targetId: target.targetId,
        targetPath: target.path,
        tier: target.tier,
        generation: target.generation,
        clusterId: target.placement.clusterId,
        productId: target.productId,
        projectId: target.projectId,
        environmentId: target.environmentId,
      },
      content: content as unknown as JsonObject,
      analysis: {
        reportId,
        imported: rows.length,
        notImported: items.filter((i) => i.kind === 'file').length - rows.length,
        decisions: items.filter((i) => i.decision !== null).length,
      },
      policy,
    },
    { clock: ctx.policy.clock },
  )
}

async function liveState(
  reader: CatalogReader,
  scope: ManagedScope,
): Promise<{ fingerprint: string; ledgerStateHash: string; baselineId: string | null }> {
  const meta = await readLedgerMeta(reader)
  const rows = await readLedgerRows(reader)
  const snapshot = await snapshotWithin(reader, scopeOf(scope))
  return {
    fingerprint: snapshot.fingerprint,
    ledgerStateHash: ledgerHashOf(rows, meta?.baselineId ?? null),
    baselineId: meta?.baselineId ?? null,
  }
}

/**
 * The content of a re-verification of a recorded baseline (`migration.verify`
 * with a baseline ref; follow-up 3, F3): the baseline's own plan, by id,
 * whose content (the reviewed report, the rows, the expected fingerprint)
 * the run checks again.
 */
export interface BaselineVerifyContent {
  readonly baseline: true
  readonly projectId: string
  readonly targetId: string
  readonly path: string
  readonly tier: 'prod' | 'nonprod'
  readonly generation: number
  readonly migrationId: string
  readonly baselinePlanId: string
  readonly baselineOperationId: string
  readonly reportId: string
}

/**
 * The baseline a recorded `baseline:<slug>` ledger row stands for, read for
 * a re-verification: the row (not reverted), the baseline plan that wrote it
 * and its report, baselined by that operation. Anything else is NOT_FOUND.
 */
export async function baselineToVerify(
  tx: Tx,
  connector: MigrationPlanContext['connector'],
  target: TargetRecord,
  migrationId: string,
): Promise<
  Omit<
    BaselineVerifyContent,
    'baseline' | 'projectId' | 'targetId' | 'path' | 'tier' | 'generation'
  >
> {
  const opened = await connector.forTarget(target, 'observer', `verify-plan/${target.targetId}`)
  let row: Awaited<ReturnType<typeof readLedgerRows>>[number] | undefined
  try {
    row = (await opened.session.readOnly((rtx) => readLedgerRows(rtx))).find(
      (r) => r.migrationId === migrationId,
    )
  } finally {
    await opened.session.close()
  }
  if (row === undefined || row.origin !== 'baseline' || row.planId === null) {
    throw new MigrationError('NOT_FOUND')
  }
  if (row.revertedAt !== null) throw new MigrationError('MIGRATION_REVERTED', { migrationId })
  const plan = await readPlan(tx, row.planId)
  if (plan === undefined || plan.kind !== 'migration.baseline')
    throw new MigrationError('NOT_FOUND')
  const c = baselineContentOf(plan)
  const report = await readReport(tx, c.reportId)
  if (
    c.baselineId !== migrationId ||
    c.target.targetId !== target.targetId ||
    report === undefined ||
    report.state !== 'baselined' ||
    report.baselineOperationId !== row.operationId
  ) {
    throw new MigrationError('NOT_FOUND')
  }
  return {
    migrationId,
    baselinePlanId: plan.planId,
    baselineOperationId: row.operationId,
    reportId: c.reportId,
  }
}

/** Runs a planned re-verification of a baseline (the `migration.verify` kind's baseline variant). */
export async function verifyBaselineAgain(
  deps: MigrationKindDeps,
  c: BaselineVerifyContent,
  fence: Fence,
): Promise<VerificationRun['status']> {
  const plan = await readPlan(deps.store, c.baselinePlanId)
  if (plan === undefined) throw new MigrationError('NOT_FOUND')
  const content = baselineContentOf(plan)
  // The target may have been re-registered since: verify what is there now, as this plan saw it.
  return (
    await verifyBaseline(
      deps,
      { ...content, target: { ...content.target, generation: c.generation } },
      fence,
    )
  ).status
}

/**
 * The verification of a recorded baseline (legacy-import.md §2 step 7):
 * the baseline's own run on the target and in the mirror, also when it is
 * run again later (`migration.verify` of a baseline ref, follow-up 3 F3).
 *
 * - L3: the managed scope's fingerprint is the reviewed one.
 * - L1: every accepted file's surviving structural and cluster-global
 *   expectations hold, except those a person's decision excused: a
 *   decision that accepts a file as applied excuses exactly the failures
 *   the analysis recorded for it, failing the same way (the same aspects);
 *   one that fails another way, or anything the analysis did not show,
 *   fails the run. A report analyzed before failures were recorded excuses
 *   every failure of a file a person accepted, bound by the fingerprint.
 *   A file decided `superseded` states nothing any more and is not checked.
 * - Every failure is kept with the run (the first 200, and how many).
 * - A passed run makes the schema the target's expected state for drift.
 */
export async function verifyBaseline(
  deps: MigrationKindDeps,
  c: BaselineContent,
  fence: Fence,
): Promise<VerificationRun> {
  const { operationId } = fence
  const target = await findTarget(deps.store, c.target.targetId)
  if (target === undefined) throw new MigrationError('TARGET_NOT_FOUND')
  const project = await projectRegistry(deps.store, c.projectId)
  const files = await readFiles(deps.store, c.reportId)
  const items = await readItems(deps.store, c.reportId)
  // The decisions the plan bound, unchanged since: a decision recorded after the plan (the
  // report is baselined only when the mirror is written) would change what is excused.
  const reviewed = reportDigest(files, items) === c.reportDigest
  const byStem = new Map(items.filter((i) => i.kind === 'file').map((i) => [i.name, i]))
  const imported = new Set(c.rows.map((r) => r.name))
  const startedAt = new Date().toISOString()
  const opened = await deps.connector.forTarget(target, 'observer', `verify/${operationId}`)
  let fingerprint: string
  let unparsed: string | null
  let checked = 0
  const failures: (ExpectationFailure & { excused: boolean })[] = []
  // The migrations applied after the baseline (follow-up 4): their verified states are a way
  // the schema may have moved on, and their up.sql supersedes what the history stated.
  let later: Awaited<ReturnType<typeof readLedgerRows>> = []
  let verifications: Awaited<ReturnType<typeof readVerifications>> = []
  const unstored: string[] = []
  try {
    await loadParser(opened.session.facts.major)
    ;({ later, verifications } = await opened.session.readOnly(async (rtx) => ({
      later: rowsAfterBaseline(await readLedgerRows(rtx), c.baselineId),
      verifications: await readVerifications(rtx),
    })))
    const applicable = files.filter((f) => !c.notApplicable.includes(f.stem))
    const bundles: ImportFile[] = []
    for (const row of later) {
      if (row.origin !== 'exponetdb') continue
      const revision = (await revisionsOf(deps.store, c.projectId, row.migrationId)).find(
        (r) => r.checksum === row.checksum,
      )
      if (revision === undefined) {
        unstored.push(row.migrationId)
        continue
      }
      bundles.push({
        position: applicable.length + bundles.length,
        stem: row.migrationId,
        bytes: revision.files['up.sql'],
        checksum: revision.checksum,
        sourceDigest: revision.sourceDigest,
        bytesDigest: revision.sourceDigest,
      })
    }
    const replays = await replaysOf(
      opened.session.facts.major,
      applicable,
      project.trustedExtensions,
    )
    for (const [stem, replay] of await replaysOf(
      opened.session.facts.major,
      bundles,
      project.trustedExtensions,
    )) {
      replays.set(stem, replay)
    }
    ;({ fingerprint, unparsed } = await opened.session.readOnly(async (rtx) => {
      const snapshot = await snapshotWithin(rtx, scopeOf(project.scope))
      // The history, then what was migrated on top of it: a baseline expectation a later
      // migration superseded on purpose is not checked (that migration's own verification
      // checked what it left). Only the history's files are checked here.
      const chain = analyzeChain([...applicable, ...bundles], replays)
      // A chain the imported target's major cannot parse checks nothing: never passed on the
      // fingerprint alone.
      if ('failedAt' in chain)
        return { fingerprint: snapshot.fingerprint, unparsed: chain.failedAt }
      await pinSearchPath(rtx, c.searchPath)
      for (const a of chain) {
        const item = byStem.get(a.file.stem)
        if (!imported.has(a.file.stem) || item === undefined) continue
        if (effective(item) === 'superseded') continue
        // Each file's checks on their own, as in the analysis: a check that raises (a schema
        // the observer may not use) is that file's failure, never the run's error.
        const found: ExpectationFailure[] = []
        if (a.surviving.length > 0) {
          const structural = await guarded(rtx, async () => {
            await pinSearchPath(rtx, c.searchPath)
            return checkExpectations(rtx, a.surviving)
          })
          if (structural === undefined) {
            checked += 1
            found.push(unreadableFailure(a.file.stem, 'structural'))
          } else {
            checked += structural.length
            found.push(...structuralFailures(a.file.stem, structural))
          }
        }
        if (a.survivingGlobals.length > 0) {
          const globals = await guarded(rtx, () =>
            checkClusterGlobalExpectations(rtx, a.survivingGlobals),
          )
          if (globals === undefined) {
            checked += 1
            found.push(unreadableFailure(a.file.stem, 'cluster_global'))
          } else {
            const applied = globals.filter((r) => r.applies)
            checked += applied.length
            found.push(...clusterGlobalFailures(a.file.stem, applied))
          }
        }
        const decision = {
          accepted: item.decision !== null && APPLIED.has(item.decision.state),
          recorded: item.failing,
        }
        for (const f of found) failures.push({ ...f, excused: excusedBy(decision, f) })
      }
      return { fingerprint: snapshot.fingerprint, unparsed: null }
    }))
  } finally {
    await opened.session.close()
  }
  const accepted = acceptBaselineSchema({
    reviewed: c.expectedState.schemaFingerprint,
    live: fingerprint,
    later,
    verifications,
  })
  const firstUnstored = unstored[0]
  const engineFailure =
    firstUnstored !== undefined
      ? {
          name: `schema after the baseline: ${firstUnstored}`.slice(0, 128),
          detail: 'its bundle is not in the bundle store, so what it superseded is unknown',
        }
      : accepted.kind === 'failed'
        ? { name: accepted.name, detail: accepted.detail }
        : null
  const matches = engineFailure === null
  if (!reviewed) {
    failures.unshift({
      file: null,
      statement: null,
      kind: 'import_report',
      object: 'the decisions of the reviewed import report',
      failed: ['changed'],
      excused: false,
    })
  }
  const open = failures.filter((f) => !f.excused)
  const excused = failures.length - open.length
  const first = open[0]
  const structural: Layer =
    unparsed !== null
      ? {
          status: 'error',
          checks: 0,
          failed: 0,
          firstFailure: { name: `unparsed: ${unparsed}`.slice(0, 128), detail: null },
        }
      : {
          status: checked === 0 ? 'skipped' : open.length === 0 ? 'passed' : 'failed',
          checks: checked,
          failed: open.length,
          firstFailure:
            first === undefined
              ? null
              : { name: first.object.slice(0, 128), detail: first.failed.join(', ').slice(0, 200) },
          excused,
          ...keptFailures(failures),
        }
  const engine: Layer = {
    status: matches ? 'passed' : 'failed',
    checks: 1,
    failed: matches ? 0 : 1,
    firstFailure: engineFailure,
    ...(matches && accepted.kind === 'chain'
      ? { acceptedThrough: { migrations: accepted.migrations, last: accepted.last } }
      : {}),
  }
  const runtime: Layer = { status: 'skipped', checks: 0, failed: 0, firstFailure: null }
  const status = unparsed === null && matches && open.length === 0 ? 'passed' : 'failed'
  const run: VerificationRun = {
    verificationId: newId('vfy', Date.now()),
    migrationId: c.baselineId,
    verifyDigest: null,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    structural,
    runtime,
    engine,
    fingerprint,
  }
  const writer = await deps.connector.forTarget(target, 'migrator', operationId)
  try {
    await writer.session.transaction(() =>
      insertVerification(writer.session, {
        ...run,
        operationId,
        structural: run.structural as unknown as JsonObject,
        runtime: null,
        engine: run.engine as unknown as JsonObject,
      }),
    )
  } finally {
    await writer.session.close()
  }
  await fenced(fence, 'migrations.baseline.verified', (tx) =>
    writeVerificationMirror(
      tx,
      { targetId: target.targetId, generation: c.target.generation, operationId },
      run,
    ),
  )
  // After later migrations the drift reference is already the newest verified schema (the last
  // one's): a passed baseline run never moves it back (follow-up 4).
  if (status === 'passed' && later.length === 0) {
    try {
      // Only while this worker still holds the operation: a stale one never moves the reference.
      await fenced(fence, 'migrations.baseline.expected', async () => undefined)
      // Best effort, as after a verified migration: the next drift check says what it left.
      await deps.expected?.record({
        targetId: target.targetId,
        generation: c.target.generation,
        operationId,
        fingerprint,
      })
    } catch {
      // The drift check reports what the baseline does not explain.
    }
  }
  return run
}

const SET_BASELINE = sql`UPDATE exponetdb.ledger_meta SET baseline_id = $1 WHERE baseline_id IS NULL`

/** `migration.baseline`: the imported history and the baseline, in one transaction on the target. */
export class MigrationBaselineKind implements OperationKind {
  readonly kind = 'migration.baseline'
  readonly version = 1
  readonly actionClass = 'high' as const
  readonly verifies = true
  readonly #deps: MigrationKindDeps

  constructor(deps: MigrationKindDeps) {
    this.#deps = deps
  }

  exclusivity(plan: PlanRecord): readonly string[] {
    try {
      return [`target:${baselineContentOf(plan).target.targetId}:schema`]
    } catch {
      return []
    }
  }

  async checkBindings(plan: PlanRecord): Promise<readonly ChangedBinding[]> {
    let c: BaselineContent
    try {
      c = baselineContentOf(plan)
    } catch {
      return [{ binding: 'content', actual: 'invalid' }]
    }
    const target = await findTarget(this.#deps.store, c.target.targetId)
    if (
      target === undefined ||
      target.state !== 'active' ||
      target.generation !== c.target.generation
    ) {
      return [{ binding: 'target', actual: target?.state ?? 'missing' }]
    }
    const report = await readReport(this.#deps.store, c.reportId)
    const items = await readItems(this.#deps.store, c.reportId)
    const files = await readFiles(this.#deps.store, c.reportId)
    if (report?.state !== 'open' || reportDigest(files, items) !== c.reportDigest) {
      return [{ binding: 'report', actual: report?.state ?? 'missing' }]
    }
    const project = await projectRegistry(this.#deps.store, c.projectId)
    try {
      const opened = await this.#deps.connector.forTarget(
        target,
        'observer',
        `bindings/${target.targetId}`,
      )
      try {
        const live = await opened.session.readOnly((rtx) => liveState(rtx, project.scope))
        const changed: ChangedBinding[] = []
        if (live.fingerprint !== c.expectedState.schemaFingerprint) {
          changed.push({ binding: 'fingerprint', actual: 'changed' })
        }
        if (live.ledgerStateHash !== c.expectedState.ledgerStateHash || live.baselineId !== null) {
          changed.push({ binding: 'ledger', actual: 'changed' })
        }
        return changed
      } finally {
        await opened.session.close()
      }
    } catch {
      return [{ binding: 'target', actual: 'unreachable' }]
    }
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const c = baselineContentOf(ctx.plan)
    const fence: Fence = {
      store: this.#deps.store,
      operationId: ctx.operationId,
      leaseOwner: ctx.leaseOwner,
    }
    const target = await findTarget(this.#deps.store, c.target.targetId)
    if (target === undefined) return { outcome: 'not_applied', errorCode: 'TARGET_NOT_FOUND' }
    const project = await projectRegistry(this.#deps.store, c.projectId)
    const opened = await this.#deps.connector.forTarget(target, 'migrator', ctx.operationId)
    const session = opened.session
    let release: (() => Promise<void>) | undefined
    try {
      try {
        release = await takeTargetLock(session, target.targetId, 'schema', {
          deadlineMs: 30_000,
          signal: ctx.signal,
        })
      } catch (error) {
        if (error instanceof LockUnavailable) {
          return { outcome: 'not_applied', errorCode: 'MIGRATION_LOCK_TIMEOUT' }
        }
        throw error
      }
      const result = await this.#record(ctx, c, project.scope, session)
      if (result !== 'applied') return result
      const rows = await session.readOnly((rtx) => readLedgerRows(rtx))
      await fenced(fence, 'migrations.baseline.recorded', async (tx) => {
        await writeMirror(tx, {
          targetId: target.targetId,
          generation: c.target.generation,
          rows,
          ledgerStateHash: ledgerHashOf(rows, c.baselineId),
          baselineId: c.baselineId,
        })
        await tx.query(
          'migrations.baseline.report',
          `UPDATE migrations.import_reports
              SET state = 'baselined', baseline_operation_id = $2, baselined_at = clock_timestamp()
            WHERE report_id = $1 AND state = 'open'`,
          [c.reportId, ctx.operationId],
        )
      })
      return 'applied'
    } catch (error) {
      if (error instanceof LeaseLost) return 'unknown'
      throw error
    } finally {
      await release?.().catch(() => undefined)
      await session.close()
    }
  }

  async #record(
    ctx: ExecutionContext,
    c: BaselineContent,
    scope: ManagedScope,
    session: TargetSession,
  ): Promise<ExecutionOutcome> {
    const reader = session.reader()
    await session.query(sql`BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE`)
    let commitSent = false
    let committed = false
    try {
      await lockMarker(session, {
        installationId: this.#deps.installationId,
        targetId: c.target.targetId,
        generation: c.target.generation,
        systemIdentifier: c.target.clusterSystemIdentifier,
      })
      const live = await liveState(reader, scope)
      if (
        live.fingerprint !== c.expectedState.schemaFingerprint ||
        live.ledgerStateHash !== c.expectedState.ledgerStateHash ||
        live.baselineId !== null
      ) {
        await session.query(sql`ROLLBACK`)
        return {
          outcome: 'not_applied',
          errorCode: 'PLAN_STALE',
          detail: { changedBindings: ['fingerprint'] },
        }
      }
      const common = {
        sourceDigest: null as string | null,
        verifyDigest: null,
        rollbackDigest: null,
        manifest: null,
        dependencies: [] as string[],
        transactional: null,
        applyDurationMs: null,
        planId: ctx.plan.planId,
        operationId: ctx.operationId,
        actorRef: ctx.plan.actor.identityId,
        clientRef: ctx.plan.actor.clientId,
        engineVersion: this.#deps.engineVersion,
        pgVersionNum: session.facts.serverVersionNum,
        fingerprintBefore: c.expectedState.schemaFingerprint,
        fingerprintAfter: c.expectedState.schemaFingerprint,
      }
      for (const row of c.rows) {
        await insertLedgerRow(session, {
          ...common,
          migrationId: row.migrationId,
          origin: 'legacy_import',
          name: row.name,
          checksum: row.checksum,
          checksumProvenance: row.provenance,
          sourceDigest: row.sourceDigest,
          source: {
            reportId: c.reportId,
            ...(row.appliedAt === null ? { appliedAtUnknown: true } : { appliedAt: row.appliedAt }),
          },
        })
        await insertMigrationEvent(session, {
          migrationId: row.migrationId,
          operationId: ctx.operationId,
          event: 'imported',
          detail: { reportId: c.reportId, provenance: row.provenance },
        })
      }
      await insertLedgerRow(session, {
        ...common,
        migrationId: c.baselineId,
        origin: 'baseline',
        name: c.baselineId.slice('baseline:'.length),
        checksum: c.reportDigest,
        checksumProvenance: 'computed_at_apply',
        source: { reportId: c.reportId, imported: c.rows.length },
      })
      await insertMigrationEvent(session, {
        migrationId: c.baselineId,
        operationId: ctx.operationId,
        event: 'baselined',
        detail: { reportId: c.reportId, imported: c.rows.length },
      })
      await session.query(SET_BASELINE, [c.baselineId])
      // Recording changes no object of the managed scope.
      const after = await snapshotWithin(reader, scopeOf(scope))
      if (after.fingerprint !== c.expectedState.schemaFingerprint) {
        await session.query(sql`ROLLBACK`)
        return { outcome: 'not_applied', errorCode: 'VERIFICATION_FAILED' }
      }
      if (!(await leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner))) {
        await session.query(sql`ROLLBACK`)
        return 'unknown'
      }
      commitSent = true
      await session.query(sql`COMMIT`)
      committed = true
      return 'applied'
    } catch (error) {
      if (commitSent && !committed) return 'unknown'
      throw error
    } finally {
      if (!committed && !commitSent && session.usable) {
        await session.query(sql`ROLLBACK`).catch(() => undefined)
      }
    }
  }

  /**
   * L3: the fingerprint is the reviewed one; L1: the accepted files'
   * surviving expectations hold, except what a person's recorded decision
   * excused (follow-up 3, F1). The run says what failed (F2); a passed run
   * makes the schema the drift reference (F4).
   */
  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    try {
      const fence = {
        store: this.#deps.store,
        operationId: ctx.operationId,
        leaseOwner: ctx.leaseOwner,
      }
      return (await verifyBaseline(this.#deps, baselineContentOf(ctx.plan), fence)).status
    } catch {
      return 'error'
    }
  }

  async reconcile(ctx: ExecutionContext): Promise<'applied' | 'not_applied' | 'unknown'> {
    const c = baselineContentOf(ctx.plan)
    const target = await findTarget(this.#deps.store, c.target.targetId)
    if (target === undefined) return 'unknown'
    try {
      const opened = await this.#deps.connector.forTarget(
        target,
        'migrator',
        `reconcile/${ctx.operationId}`,
      )
      let release: (() => Promise<void>) | undefined
      try {
        release = await takeTargetLock(opened.session, target.targetId, 'schema', {
          deadlineMs: 120_000,
          signal: ctx.signal,
        })
        const rows = await opened.session.readOnly((rtx) => readLedgerRows(rtx))
        const row = rows.find((r) => r.migrationId === c.baselineId)
        if (row === undefined) return 'not_applied'
        return row.operationId === ctx.operationId ? 'applied' : 'not_applied'
      } finally {
        await release?.().catch(() => undefined)
        await opened.session.close()
      }
    } catch {
      return 'unknown'
    }
  }
}
