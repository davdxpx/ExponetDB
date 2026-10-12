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
} from '@exponetdb/operations'
import {
  type CanonicalDocument,
  type CatalogReader,
  checkExpectations,
  diffDocuments,
  insertLedgerRow,
  insertMigrationEvent,
  insertVerification,
  LockUnavailable,
  lockMarker,
  pinSearchPath,
  readLedgerMeta,
  readLedgerRows,
  snapshotWithin,
  sql,
  type TargetSession,
  takeTargetLock,
} from '@exponetdb/postgres'
import {
  analyzeMigrationSql,
  type Expectation,
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
} from '@exponetdb/registry'
import type { PlanContent, PlanItem } from './content.ts'
import { type MigrationKindDeps, projectRegistry } from './deps.ts'
import { MigrationError } from './errors.ts'
import { runTransactional } from './executor.ts'
import type { MigrationPlanContext } from './planner.ts'
import { type Fence, fenced, LeaseLost, writeMirror } from './records.ts'
import type { StoredRevision } from './store.ts'
import { ledgerHashOf, type ManagedScope } from './target.ts'

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
  readonly aliases: Readonly<Record<string, string>>
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
  readonly executionRole: string
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
}

async function readReport(q: Queryable, reportId: string): Promise<ReportRecord | undefined> {
  const { rows } = await q.query(
    'migrations.import.report',
    `SELECT report_id, target_id, project_id, scratch_target_id, baseline_id, state, fingerprint,
            replay_fingerprint, incomplete_reason, hints,
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
  }
}

function hintsFrom(value: unknown): Hints {
  const h = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const aliases: Record<string, string> = {}
  if (typeof h['aliases'] === 'object' && h['aliases'] !== null) {
    for (const [k, v] of Object.entries(h['aliases'])) if (typeof v === 'string') aliases[k] = v
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
            evidence, decision_state, decision_note, decided_by,
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
    state: report.state === 'open' && unresolved === 0 ? ('resolved' as const) : report.state,
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
      decision:
        i.decision === null
          ? null
          : { state: i.decision.state, note: i.decision.note, decidedAt: i.decision.decidedAt },
    })),
    unresolved,
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
  readonly aliases?: Readonly<Record<string, string>> | undefined
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
  const project = await projectRegistry(tx, target.projectId)
  const executionRole = project.executionRoles[request.role ?? 'owner']
  if (executionRole === undefined) {
    throw invalid('/role', 'execution_role_unmapped', 'The execution role alias is not mapped.')
  }
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
  for (const [name, s] of Object.entries(request.aliases ?? {})) {
    if (!stems.has(s)) {
      throw invalid(
        `/aliases/${name}`,
        'unknown_stem',
        'An alias names a file that was not submitted.',
      )
    }
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
    aliases: { ...(request.aliases ?? {}) },
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
    executionRole,
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
      analysis: { reportId, files: files.length, scratchTargetId: scratch.targetId },
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
  readonly name: string
  /** sha256:<hex> of the file bytes (drizzle), or null. */
  readonly bytesDigest: string | null
  /** The applied statements, whitespace-collapsed (supabase), or null. */
  readonly statements: readonly string[] | null
  readonly appliedAt: string | null
}

const LEDGER_PRESENT = sql`SELECT pg_catalog.to_regclass($1) IS NOT NULL AS present`
const SUPABASE = sql`SELECT version::text AS version, coalesce(name::text, '') AS name,
       coalesce(pg_catalog.to_jsonb(statements), '[]'::jsonb) AS statements
  FROM supabase_migrations.schema_migrations ORDER BY version`
const DRIZZLE = sql`SELECT hash::text AS hash, created_at::text AS created_at
  FROM drizzle.__drizzle_migrations ORDER BY id`
const APPLIED_MIGRATIONS = sql`SELECT filename::text AS filename,
       to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS applied_at
  FROM public.applied_migrations ORDER BY applied_at`

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/;$/, '')
}

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
          entries.push({
            source: ledger,
            name: [r.text('version'), r.text('name')].filter((x) => x !== '').join('_'),
            bytesDigest: null,
            statements: Array.isArray(statements) ? statements.map((s) => collapse(String(s))) : [],
            appliedAt: null,
          })
        }
      } else if (ledger === 'drizzle') {
        for (const r of await reader.query(DRIZZLE)) {
          entries.push({
            source: ledger,
            name: r.text('hash'),
            bytesDigest: `sha256:${r.text('hash').toLowerCase()}`,
            statements: null,
            appliedAt: null,
          })
        }
      } else {
        for (const r of await reader.query(APPLIED_MIGRATIONS)) {
          entries.push({
            source: ledger,
            name: r.text('filename').replace(/\.sql$/, ''),
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
async function guarded<T>(reader: CatalogReader, fn: () => Promise<T>): Promise<T | undefined> {
  await reader.query(sql`SAVEPOINT exdb_import_read`)
  try {
    const value = await fn()
    await reader.query(sql`RELEASE SAVEPOINT exdb_import_read`)
    return value
  } catch {
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
}

/** Each file's statements and, over the whole chain, the expectations that survive later files. */
function analyzeChain(
  major: 16 | 17 | 18,
  files: readonly ImportFile[],
  trusted: readonly string[],
): FileAnalysis[] | { readonly failedAt: string } {
  const perFile: StatementFacts[][] = []
  for (const f of files) {
    const text = normalizeSqlSource(f.bytes)
    const analysis = text.ok
      ? analyzeMigrationSql(major, text.value, { trustedExtensions: trusted })
      : null
    if (analysis === null || !analysis.ok) return { failedAt: f.stem }
    perFile.push([...analysis.statements])
  }
  // One chain: statement k of file i gets a global index, survivors map back to their file.
  const flat: StatementFacts[] = []
  const owner: number[] = []
  for (const [i, statements] of perFile.entries()) {
    for (const s of statements) {
      flat.push({ ...s, index: flat.length })
      owner.push(i)
    }
  }
  const survivors = survivingExpectations(flat)
  return files.map((file, i) => {
    const statements = perFile[i] ?? []
    return {
      file,
      statements,
      expectations: statements.flatMap((s) => [...s.expectations]),
      surviving: survivors.filter((x) => owner[x.statement] === i),
      underived: statements.some((s) => s.procedural || s.coverage !== 'derived'),
    }
  })
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
  const used = new Set<LegacyLedgerEntry>()
  const aliasOf = new Map<string, string[]>()
  for (const [applied, stem] of Object.entries(hints.aliases)) {
    aliasOf.set(stem, [...(aliasOf.get(stem) ?? []), applied])
  }
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
      })
      continue
    }
    // Ledger evidence, strongest first; a numeric prefix is never used.
    let provenance: Provenance | null = null
    let appliedAt: string | null = null
    const statementTexts = (() => {
      const text = normalizeSqlSource(a.file.bytes)
      return text.ok ? a.statements.map((s) => collapse(text.value.slice(s.start, s.end))) : []
    })()
    for (const e of ledger) {
      let match: Provenance | null = null
      let what = ''
      if (e.bytesDigest !== null && e.bytesDigest === a.file.bytesDigest) {
        match = 'legacy_tool_hash'
        what = `${e.source}:hash`
      } else if (
        e.statements !== null &&
        e.statements.length > 0 &&
        e.statements.length === statementTexts.length &&
        e.statements.every((s, i) => s === statementTexts[i])
      ) {
        match = 'legacy_applied_statements'
        what = `${e.source}:statements`
      } else if ((aliasOf.get(stem) ?? []).includes(e.name)) {
        match = 'legacy_file_at_import'
        what = `${e.source}:alias`
      } else if (e.name === stem) {
        match = 'unknown'
        what = `${e.source}:name_hint`
      }
      if (match === null) continue
      used.add(e)
      evidence.push(what)
      appliedAt ??= e.appliedAt
      const rank = (p: Provenance | null) =>
        p === 'legacy_tool_hash'
          ? 3
          : p === 'legacy_applied_statements'
            ? 2
            : p === 'legacy_file_at_import'
              ? 1
              : p === 'unknown'
                ? 0
                : -1
      if (rank(match) > rank(provenance)) provenance = match
    }
    const recorded = provenance !== null
    // Effects: the file's surviving expectations on the imported target.
    let state: ImportItemState
    if (a.expectations.length === 0) {
      evidence.push(a.underived ? 'effects_not_derivable' : 'no_structural_expectations')
      state = recorded && provenance !== 'unknown' ? 'recorded_present' : 'ambiguous'
    } else if (a.surviving.length === 0) {
      evidence.push('expectations_superseded')
      state = 'superseded'
    } else {
      let held = 0
      const results = await guarded(reader, async () => {
        await pinSearchPath(reader, searchPath)
        return checkExpectations(reader, a.surviving)
      })
      if (results === undefined) {
        evidence.push('expectations_unreadable')
        held = -1
      } else {
        held = results.filter((r) => r.ok).length
        evidence.push(`expectations_held:${held}/${results.length}`)
      }
      if (held === -1 || (held > 0 && held < a.surviving.length)) {
        state = 'ambiguous'
      } else if (held === a.surviving.length) {
        state = recorded ? 'recorded_present' : 'unrecorded_present'
      } else {
        state = recorded ? 'recorded_missing' : 'unrecorded_missing'
      }
      if (a.underived && state !== 'ambiguous') {
        evidence.push('partly_derived')
        if (state === 'unrecorded_present') state = 'ambiguous'
      }
    }
    out.push({
      kind: 'file',
      legacyId: `legacy:${stem}`,
      name: stem,
      state,
      contentDigest: a.file.sourceDigest,
      provenance:
        state === 'recorded_present' || state === 'unrecorded_present' || state === 'superseded'
          ? provenance === 'unknown' || provenance === null
            ? 'legacy_file_at_import'
            : provenance
          : null,
      appliedAt,
      evidence: evidence.slice(0, 16),
    })
  }
  for (const e of ledger) {
    if (used.has(e)) continue
    out.push({
      kind: 'ledger_entry',
      legacyId: `ledger:${e.source}:${e.name}`.slice(0, 200),
      name: e.name.slice(0, 200) || e.source,
      state: 'ambiguous',
      contentDigest: null,
      provenance: null,
      appliedAt: e.appliedAt,
      evidence: ['ledger_entry_without_file'],
    })
  }
  return out
}

const MAX_DRIFT_ITEMS = 500

/** Global drift between the replay and the target: objects no legacy file explains. */
function driftItems(replay: CanonicalDocument, target: CanonicalDocument): Classified[] {
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
      evidence: ['differs', ...c.attributes.slice(0, 8).map((a) => `attribute:${a}`)],
    })
  }
  return out.slice(0, MAX_DRIFT_ITEMS)
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
              applied_at, evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10)`,
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
          ],
        )
      }
      await tx.query(
        'migrations.import.open',
        `UPDATE migrations.import_reports
            SET state = 'open', fingerprint = $2, replay_fingerprint = $3, operation_id = $4,
                analyzed_at = clock_timestamp()
          WHERE report_id = $1 AND state = 'pending'`,
        [reportId, result.fingerprint, result.replayFingerprint, operationId],
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
      const major = session.facts.major
      await loadParser(major)
      const scope = project.scope
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
      // Files of another project or target are neither replayed nor compared.
      const skipped = new Set(c.hints.notApplicable)
      const applicable = files.filter((f) => !skipped.has(f.stem))
      for (const f of applicable) {
        if (!(await leaseHeld(this.#deps.store, ctx.operationId, ctx.leaseOwner))) {
          throw new LeaseLost()
        }
        const step = await runTransactional({
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
            files: { 'up.sql': f.bytes, 'verify.sql': null, 'down.sql': null },
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
          replay: true,
        })
        if (step.result !== 'applied') {
          const detail =
            step.result === 'failed'
              ? `replay_failed:${f.stem}:${step.errorCode}${step.statementIndex === null ? '' : `:${step.statementIndex}`}${step.sqlstate === null ? '' : `:${step.sqlstate}`}`
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
      const replay = await session.readOnly((rtx) => snapshotWithin(rtx, scopeOf(scope)))
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
            const chain = analyzeChain(major, applicable, project.trustedExtensions)
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
        await this.#finish(
          fence,
          c.reportId,
          {
            state: 'open',
            fingerprint: result.snapshot.fingerprint,
            replayFingerprint: replay.fingerprint,
            items: [...result.items, ...driftItems(replay.document, result.snapshot.document)],
          },
          ctx.operationId,
        )
      } finally {
        await observed.session.close()
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
  const unresolved = unresolvedOf(items)
  if (unresolved.length > 0) {
    throw new MigrationError('LEGACY_IMPORT_AMBIGUOUS', {
      items: unresolved.slice(0, 50).map((i) => ({ itemId: String(i.itemId) })),
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

  /** L3: the fingerprint is the reviewed one; L1: the accepted files' surviving expectations hold. */
  async verify(ctx: ExecutionContext): Promise<'passed' | 'failed' | 'partial' | 'error'> {
    const c = baselineContentOf(ctx.plan)
    const target = await findTarget(this.#deps.store, c.target.targetId)
    if (target === undefined) return 'error'
    const project = await projectRegistry(this.#deps.store, c.projectId)
    const files = await readFiles(this.#deps.store, c.reportId)
    const accepted = new Set(c.rows.filter((r) => r.surviving).map((r) => r.name))
    const startedAt = new Date().toISOString()
    try {
      const opened = await this.#deps.connector.forTarget(
        target,
        'observer',
        `verify/${ctx.operationId}`,
      )
      let run: { fingerprint: string; held: number; checked: number }
      try {
        await loadParser(opened.session.facts.major)
        run = await opened.session.readOnly(async (rtx) => {
          const snapshot = await snapshotWithin(rtx, scopeOf(project.scope))
          const chain = analyzeChain(
            rtx.facts.major,
            files.filter((f) => !c.notApplicable.includes(f.stem)),
            project.trustedExtensions,
          )
          let held = 0
          let checked = 0
          if (!('failedAt' in chain)) {
            await pinSearchPath(rtx, c.searchPath)
            for (const a of chain) {
              if (!accepted.has(a.file.stem) || a.surviving.length === 0) continue
              const results = await checkExpectations(rtx, a.surviving)
              checked += results.length
              held += results.filter((r) => r.ok).length
            }
          }
          return { fingerprint: snapshot.fingerprint, held, checked }
        })
      } finally {
        await opened.session.close()
      }
      const passed =
        run.fingerprint === c.expectedState.schemaFingerprint && run.held === run.checked
      const status = passed ? 'passed' : 'failed'
      const writer = await this.#deps.connector.forTarget(target, 'migrator', ctx.operationId)
      try {
        await writer.session.transaction(() =>
          insertVerification(writer.session, {
            verificationId: newId('vfy', Date.now()),
            migrationId: c.baselineId,
            operationId: ctx.operationId,
            verifyDigest: null,
            startedAt,
            finishedAt: new Date().toISOString(),
            status,
            structural: { checked: run.checked, held: run.held } as JsonObject,
            runtime: null,
            engine: {
              fingerprint:
                run.fingerprint === c.expectedState.schemaFingerprint ? 'match' : 'mismatch',
            } as JsonObject,
            fingerprint: run.fingerprint,
          }),
        )
      } finally {
        await writer.session.close()
      }
      return status
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
