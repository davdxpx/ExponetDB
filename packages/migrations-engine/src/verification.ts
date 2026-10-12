import { newId } from '@exponetdb/kernel'
import { normalizeSqlSource } from '@exponetdb/migrations/format'
import {
  admitChecks,
  type CatalogReader,
  type CheckOutcome,
  changedConsumerCode,
  checkExpectations,
  type ExpectationResult,
  pinSearchPath,
  resolveVerifyCatalog,
  snapshotWithin,
  sql,
  TargetError,
  verifierProblems,
} from '@exponetdb/postgres'
import {
  analyzeMigrationSql,
  analyzeVerifyFile,
  loadParser,
  survivingExpectations,
} from '@exponetdb/postgres/parser'
import type { Connector, TargetRecord } from '@exponetdb/registry'
import type { PlanItem } from './content.ts'
import type { StoredRevision } from './store.ts'
import type { ManagedScope } from './target.ts'

/**
 * Verification after commit ([verification.md §2](../../../exponetdb-docs/04-migrations/verification.md#2-the-layers-l0-to-l4)):
 *
 * - L1 structural: the engine's expectations again, from a fresh read-only
 *   observer connection under the migration's search path;
 * - L2 runtime: exactly the plan's reviewed `verify.sql`, on its own
 *   verifier connection, after the verifier's drift and the consumer code
 *   the plan bound were checked again;
 * - L3 engine: the fingerprint equals what the migration recorded, no
 *   invalid index in the managed scope, the relations the migration
 *   created are owned by its execution role, the extensions are as bound.
 *
 * Only the result contract is kept: counts, the first failing check's name
 * and redacted detail, never rows. Layers that do not apply are `skipped`.
 * A run never executes `up.sql`.
 */
export type LayerStatus = 'passed' | 'failed' | 'partial' | 'error' | 'skipped'

export interface Layer {
  readonly status: LayerStatus
  readonly checks: number
  readonly failed: number
  readonly firstFailure: { readonly name: string; readonly detail: string | null } | null
}

export interface VerificationRun {
  readonly verificationId: string
  readonly migrationId: string
  readonly verifyDigest: string | null
  readonly status: 'passed' | 'failed' | 'partial' | 'error'
  readonly startedAt: string
  readonly finishedAt: string
  readonly structural: Layer
  readonly runtime: Layer
  readonly engine: Layer
  readonly fingerprint: string
}

const SKIPPED: Layer = { status: 'skipped', checks: 0, failed: 0, firstFailure: null }

function layerOf(results: readonly { ok: boolean; name: string; detail?: string | null }[]): Layer {
  const failed = results.filter((r) => !r.ok)
  const first = failed[0]
  return {
    status: results.length === 0 ? 'skipped' : failed.length === 0 ? 'passed' : 'failed',
    checks: results.length,
    failed: failed.length,
    firstFailure:
      first === undefined ? null : { name: first.name.slice(0, 128), detail: first.detail ?? null },
  }
}

function errorLayer(name: string, checks = 0): Layer {
  return {
    status: 'error',
    checks,
    failed: 0,
    firstFailure: { name: name.slice(0, 128), detail: null },
  }
}

export function structuralLayer(results: readonly ExpectationResult[]): Layer {
  return layerOf(results.map((r) => ({ ok: r.ok, name: r.description })))
}

/** The expectations of a migration's up.sql that must hold after it (verification.md §3). */
export function expectationsOf(
  major: 16 | 17 | 18,
  revision: StoredRevision,
  trusted: readonly string[],
  file: 'up.sql' | 'down.sql' = 'up.sql',
) {
  const bytes = revision.files[file]
  if (bytes === null) return null
  const text = normalizeSqlSource(bytes)
  if (!text.ok) return null
  const analysis = analyzeMigrationSql(major, text.value, { trustedExtensions: trusted })
  return analysis.ok ? { analysis, expectations: survivingExpectations(analysis.statements) } : null
}

const INVALID_INDEXES = sql`SELECT n.nspname::text AS schema, c.relname::text AS name
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT (i.indisvalid AND i.indisready) AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
   AND (pg_catalog.jsonb_array_length($1::jsonb) = 0
        OR n.nspname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($1::jsonb))))
   AND NOT (n.nspname = ANY (ARRAY(SELECT pg_catalog.jsonb_array_elements_text($2::jsonb))))
   AND n.nspname <> 'exponetdb'
 ORDER BY 1, 2 LIMIT 20`

const OWNERS = sql`SELECT r.item->>0 AS schema, r.item->>1 AS name,
       (SELECT pg_catalog.pg_get_userbyid(c.relowner)::text FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = r.item->>0 AND c.relname = r.item->>1) AS owner
  FROM pg_catalog.jsonb_array_elements($1::jsonb) AS r(item)`

const EXTENSIONS = sql`SELECT coalesce(pg_catalog.jsonb_object_agg(e.extname, e.extversion), '{}'::jsonb) AS versions
  FROM pg_catalog.pg_extension e`

/** The L3 checks on an observer read-only transaction. */
export async function engineLayer(
  tx: CatalogReader,
  input: {
    readonly fingerprintAfter: string | null
    readonly scope: ManagedScope
    readonly createdRelations: readonly { readonly schema: string; readonly name: string }[]
    readonly executionRole: string
    readonly extensions: Readonly<Record<string, string>> | null
  },
): Promise<{ layer: Layer; fingerprint: string }> {
  const snapshot = await snapshotWithin(tx, {
    ...(input.scope.includeSchemas === undefined
      ? {}
      : { includeSchemas: [...input.scope.includeSchemas] }),
    excludeSchemas: [...(input.scope.excludeSchemas ?? [])],
  })
  const results: { ok: boolean; name: string; detail?: string | null }[] = []
  results.push({
    ok: input.fingerprintAfter === null || snapshot.fingerprint === input.fingerprintAfter,
    name: 'fingerprint equals the one recorded at commit',
  })
  const invalid = await tx.query(INVALID_INDEXES, [
    JSON.stringify(input.scope.includeSchemas ?? []),
    JSON.stringify(input.scope.excludeSchemas ?? []),
  ])
  results.push({
    ok: invalid.length === 0,
    name: 'no invalid index in the managed scope',
    detail:
      invalid[0] === undefined
        ? null
        : `${invalid[0].text('schema')}.${invalid[0].text('name')}`.slice(0, 200),
  })
  if (input.createdRelations.length > 0) {
    const owners = await tx.query(OWNERS, [
      JSON.stringify(input.createdRelations.map((r) => [r.schema, r.name])),
    ])
    const wrong = owners.find(
      (o) => o.textOrNull('owner') !== null && o.textOrNull('owner') !== input.executionRole,
    )
    results.push({
      ok: wrong === undefined,
      name: 'created relations are owned by the execution role',
      detail:
        wrong === undefined ? null : `${wrong.text('schema')}.${wrong.text('name')}`.slice(0, 200),
    })
  }
  if (input.extensions !== null) {
    const row = (await tx.query(EXTENSIONS))[0]
    const now = row?.jsonObject('versions') ?? {}
    const changed = Object.entries(input.extensions).find(
      ([name, version]) => now[name] !== version,
    )
    results.push({
      ok: changed === undefined,
      name: 'extensions as bound by the plan',
      detail: changed === undefined ? null : changed[0],
    })
  }
  return { layer: layerOf(results), fingerprint: snapshot.fingerprint }
}

function runtimeFrom(outcomes: readonly { name: string; outcome: CheckOutcome }[]): Layer {
  const failed = outcomes.filter((o) => o.outcome.status !== 'passed')
  const errored = outcomes.some((o) => o.outcome.status === 'error')
  const first = failed[0]
  return {
    status:
      outcomes.length === 0
        ? 'skipped'
        : errored
          ? 'error'
          : failed.length > 0
            ? 'failed'
            : 'passed',
    checks: outcomes.length,
    failed: failed.length,
    firstFailure:
      first === undefined
        ? null
        : {
            name: first.name.slice(0, 128),
            detail:
              first.outcome.status === 'failed'
                ? (first.outcome.detail ?? first.outcome.reason)
                : first.outcome.status === 'error'
                  ? `${first.outcome.reason}${first.outcome.sqlstate === null ? '' : ` ${first.outcome.sqlstate}`}`
                  : null,
          },
  }
}

/** L2: the plan's verify.sql on a verifier connection (null text: no verify.sql). */
export async function runtimeLayer(
  connector: Connector,
  target: TargetRecord,
  operationId: string,
  verifyText: string | null,
  bound: PlanItem['consumerCode'],
): Promise<Layer> {
  if (verifyText === null) return SKIPPED
  let opened: Awaited<ReturnType<Connector['forTarget']>>
  try {
    opened = await connector.forTarget(target, 'verifier', `verify/${operationId}`)
  } catch {
    return errorLayer('verifier connection')
  }
  try {
    const file = analyzeVerifyFile(opened.session.facts.major, verifyText)
    if (!file.ok) return errorLayer('verify.sql admission')
    return await opened.session.readOnly(
      async (tx) => {
        const problems = await verifierProblems(tx)
        if (problems.length > 0) return errorLayer(`verifier role: ${problems.join(', ')}`)
        const resolution = await resolveVerifyCatalog(tx, file.checks)
        if (!resolution.ok) return errorLayer(`verify.sql resolution: ${resolution.reason}`)
        const changed = changedConsumerCode(bound, resolution.consumer)
        if (changed.length > 0) return errorLayer('consumer code changed since planning')
        const admitted = admitChecks(file.checks, resolution)
        const outcomes: { name: string; outcome: CheckOutcome }[] = []
        for (const check of admitted) {
          outcomes.push({ name: check.name, outcome: await tx.runCheck(check) })
        }
        return runtimeFrom(outcomes)
      },
      { statementTimeoutMs: 60_000, lockTimeoutMs: 2000 },
    )
  } catch (error) {
    return errorLayer(error instanceof TargetError ? `target: ${error.code}` : 'verification error')
  } finally {
    await opened.session.close()
  }
}

export function overall(layers: readonly Layer[]): VerificationRun['status'] {
  if (layers.some((l) => l.status === 'error')) return 'error'
  if (layers.some((l) => l.status === 'failed' || l.status === 'partial')) return 'failed'
  return 'passed'
}

/** L1 and L3 on one fresh observer connection, L2 on its own verifier connection. */
export async function verifyMigration(
  connector: Connector,
  target: TargetRecord,
  input: {
    readonly operationId: string
    readonly item: PlanItem
    readonly revision: StoredRevision
    readonly fingerprintAfter: string | null
    readonly scope: ManagedScope
    readonly trustedExtensions: readonly string[]
    readonly extensions: Readonly<Record<string, string>> | null
    /** `down.sql` for a rollback: its expectations, no verify.sql (it asserts the forward state). */
    readonly file?: 'up.sql' | 'down.sql'
  },
): Promise<VerificationRun> {
  const startedAt = new Date().toISOString()
  let structural: Layer = SKIPPED
  let engine: Layer = SKIPPED
  let fingerprint = input.fingerprintAfter ?? ''
  try {
    const opened = await connector.forTarget(target, 'observer', `verify/${input.operationId}`)
    try {
      const major = opened.session.facts.major
      await loadParser(major)
      const expected = expectationsOf(
        major,
        input.revision,
        input.trustedExtensions,
        input.file ?? 'up.sql',
      )
      const created = (expected?.analysis.statements ?? []).flatMap((s) =>
        s.details.createdTable === undefined
          ? []
          : [
              {
                schema: s.details.createdTable.schema ?? input.item.searchPath[0] ?? 'public',
                name: s.details.createdTable.name,
              },
            ],
      )
      const result = await opened.session.readOnly(
        async (tx) => {
          let l1: Layer = SKIPPED
          if (expected === null) {
            l1 = errorLayer('up.sql analysis')
          } else {
            await pinSearchPath(tx, input.item.searchPath)
            l1 = structuralLayer(await checkExpectations(tx, expected.expectations))
          }
          const l3 = await engineLayer(tx, {
            fingerprintAfter: input.fingerprintAfter,
            scope: input.scope,
            createdRelations: created,
            executionRole: input.item.executionRole,
            extensions: input.extensions,
          })
          return { l1, l3 }
        },
        { statementTimeoutMs: 60_000, lockTimeoutMs: 2000 },
      )
      structural = result.l1
      engine = result.l3.layer
      fingerprint = result.l3.fingerprint
    } finally {
      await opened.session.close()
    }
  } catch (error) {
    structural = errorLayer(
      error instanceof TargetError ? `target: ${error.code}` : 'structural verification',
    )
    engine = SKIPPED
  }
  const verifyBytes = input.file === 'down.sql' ? null : input.revision.files['verify.sql']
  const verifyText = verifyBytes === null ? null : normalizeSqlSource(verifyBytes)
  const runtime =
    verifyText !== null && !verifyText.ok
      ? errorLayer('verify.sql encoding')
      : await runtimeLayer(
          connector,
          target,
          input.operationId,
          verifyText === null ? null : verifyText.value,
          input.item.consumerCode,
        )
  return {
    verificationId: newId('vfy', Date.now()),
    migrationId: input.item.migrationId,
    verifyDigest: input.revision.verifyDigest,
    status: overall([structural, runtime, engine]),
    startedAt,
    finishedAt: new Date().toISOString(),
    structural,
    runtime,
    engine,
    fingerprint,
  }
}
