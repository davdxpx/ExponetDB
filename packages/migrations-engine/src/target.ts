import { type LedgerRow, ledgerStateHash } from '@exponetdb/migrations/format'
import {
  type CatalogReader,
  type IdentityMarker,
  installedExtensions,
  type LedgerMeta,
  type LedgerRecord,
  markerWithin,
  type RelationSize,
  readLedgerMeta,
  readLedgerRows,
  relationSizes,
  snapshotWithin,
  type TargetError,
} from '@exponetdb/postgres'
import { MigrationError } from './errors.ts'

/**
 * What a target is, read in one read-only snapshot
 * ([planning-and-apply.md §3](../../../../exponetdb-docs/04-migrations/planning-and-apply.md#3-planning-algorithm)
 * step 3): the identity marker (it must name this installation, target and
 * generation), the ledger and its `ls1` hash, the fingerprint of the
 * managed scope, the installed extensions and the relation sizes. The plan
 * binds these facts; the executor reads them again under the lock.
 */
export interface TargetState {
  readonly marker: IdentityMarker
  readonly meta: LedgerMeta
  readonly ledger: readonly LedgerRecord[]
  readonly ledgerStateHash: string
  readonly fingerprint: string
  readonly snapshotComplete: boolean
  readonly extensions: Readonly<Record<string, string>>
  readonly relations: ReadonlyMap<string, RelationSize>
  readonly systemIdentifier: string
  readonly databaseOid: string
  readonly serverVersionNum: number
  readonly observedAt: string
}

export interface ExpectedIdentity {
  readonly installationId: string
  readonly targetId: string
  readonly generation: number
  /** The registry's pinned `system_identifier` of the target's cluster. */
  readonly systemIdentifier: string | null
}

export interface ManagedScope {
  readonly includeSchemas?: readonly string[]
  readonly excludeSchemas?: readonly string[]
}

/** The `ls1` hash of ledger rows (baseline from the ledger metadata). */
export function ledgerHashOf(ledger: readonly LedgerRecord[], baselineId: string | null): string {
  const rows: LedgerRow[] = ledger.map((r) => ({
    migrationId: r.migrationId,
    checksum: r.checksum,
    reverted: r.revertedAt !== null,
  }))
  const hashed = ledgerStateHash(rows, baselineId)
  if (!hashed.ok) {
    // A ledger ExponetDB cannot hash is not one it wrote: refuse, never guess.
    throw new MigrationError('LEDGER_DIVERGENCE')
  }
  return hashed.value.hash
}

/** Checks the marker against the expected identity; a mismatch is the documented refusal. */
export function checkIdentity(
  marker: IdentityMarker,
  expected: ExpectedIdentity,
  facts: { readonly systemIdentifier: string },
): void {
  if (
    marker.installationId !== expected.installationId ||
    marker.targetId !== expected.targetId ||
    marker.generation !== expected.generation
  ) {
    throw new MigrationError('TARGET_IDENTITY_MISMATCH')
  }
  if (
    marker.clusterSystemId !== facts.systemIdentifier ||
    (expected.systemIdentifier !== null && expected.systemIdentifier !== facts.systemIdentifier)
  ) {
    throw new MigrationError('CLUSTER_IDENTITY_MISMATCH')
  }
}

/** Reads the target state inside an open read-only transaction (observer, or the migrator's re-check). */
export async function readTargetState(
  tx: CatalogReader,
  expected: ExpectedIdentity,
  scope: ManagedScope,
  options: { readonly sizes?: boolean } = {},
): Promise<TargetState> {
  const marker = await markerWithin(tx)
  if (marker.status === 'absent') {
    throw new MigrationError('LEDGER_NOT_INITIALIZED')
  }
  if (marker.status !== 'present') {
    throw new MigrationError('TARGET_IDENTITY_MISMATCH')
  }
  checkIdentity(marker.marker, expected, tx.facts)
  const meta = await readLedgerMeta(tx)
  if (meta === undefined) {
    throw new MigrationError('LEDGER_NOT_INITIALIZED')
  }
  const ledger = await readLedgerRows(tx)
  const snapshot = await snapshotWithin(tx, {
    ...(scope.includeSchemas === undefined ? {} : { includeSchemas: [...scope.includeSchemas] }),
    excludeSchemas: [...(scope.excludeSchemas ?? [])],
  })
  const extensions = await installedExtensions(tx)
  const relations = options.sizes === false ? new Map() : await relationSizes(tx)
  return {
    marker: marker.marker,
    meta,
    ledger,
    ledgerStateHash: ledgerHashOf(ledger, meta.baselineId),
    fingerprint: snapshot.fingerprint,
    snapshotComplete: snapshot.complete,
    extensions,
    relations,
    systemIdentifier: tx.facts.systemIdentifier,
    databaseOid: tx.facts.databaseOid,
    serverVersionNum: tx.facts.serverVersionNum,
    observedAt: new Date().toISOString(),
  }
}

/** A driver error of a target read, as the engine reports it (never the driver's text). */
export function targetRefusal(error: unknown): MigrationError | TargetError | unknown {
  return error
}
