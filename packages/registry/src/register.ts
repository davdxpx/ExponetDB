import { isJsonObject } from '@exponetdb/kernel'
import type { ExecutionContext, ExecutionOutcome, PlanRecord } from '@exponetdb/operations'
import {
  isEmptyLedger,
  ledgerShape,
  preflightStamp,
  readMarker,
  StampRefused,
  sql,
  stampTarget,
  TargetError,
  type TargetSession,
  takeSchemaLock,
} from '@exponetdb/postgres'
import type { Body } from './content.ts'
import { RegistryKind, refusalOf } from './kind-base.ts'
import {
  activeCredential,
  findTarget,
  getCluster,
  getDatabase,
  getEnvironment,
  liveTargetOf,
} from './reads.ts'

/**
 * `target.register` ([registry.md §2](../../../exponetdb-docs/02-control-plane/registry.md#2-registration-flows),
 * [ledger.md](../../../exponetdb-docs/04-migrations/ledger.md)): the only
 * write ExponetDB makes to a managed database in Wave 4.
 *
 * 1. The Control Store records the target (`registered`, generation 1) and
 *    its first placement, unless a registration that stopped earlier
 *    already did (the same target and placement are resumed).
 * 2. A migrator session (verified TLS, pinned `system_identifier`, the
 *    database name) takes the target's schema lock and stamps the identity
 *    marker and the empty ledger in one transaction; a Control Store, a
 *    marker of another installation or target, another generation, or an
 *    `exponetdb` schema without a marker is refused and nothing is written.
 * 3. A fresh observer session reads everything back: the marker field by
 *    field, the ledger's shape (owner, tables, no row security, documented
 *    grantees only, no rows), the cluster identity and the database oid.
 * 4. Diagnostics takes the registration snapshot (fp1) and, when it is
 *    complete, stores it as the registration baseline (the expected schema
 *    for drift until Wave 6; not a migration baseline).
 * 5. Only then the target becomes `active`.
 *
 * A failure after the stamp leaves the target `registered` (inspectable,
 * never written to again until registration completes); planning it again
 * resumes the same target, and the stamp is then a no-op. The engine's
 * verification reads everything again on fresh sessions.
 */
const DATABASE_OID = sql`SELECT d.oid::text AS oid FROM pg_catalog.pg_database d
  WHERE d.datname = pg_catalog.current_database()`

/** A failure's class for an operation event: a catalog code and reason, never a message. */
function failureClass(error: unknown): string {
  if (error instanceof TargetError) return `${error.code}:${error.reason}`
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return 'error'
}

interface ReadBack {
  readonly ok: boolean
  readonly reason?: string
}

export class TargetRegisterKind extends RegistryKind {
  readonly kind = 'target.register'
  readonly actionClass = 'standard'

  override exclusivity(plan: PlanRecord): readonly string[] {
    const content = plan.body['content']
    const targetId = isJsonObject(content) ? content['targetId'] : undefined
    return typeof targetId === 'string' ? [`target:${targetId}:schema`] : []
  }

  async bindings(_plan: PlanRecord, c: Body, expected: Body) {
    const store = this.deps.store
    const changed: {
      binding: string
      expected?: string | number | null
      actual?: string | number | null
    }[] = []
    const env = await getEnvironment(store, c.text('environmentId'))
    if (
      env === undefined ||
      env.revision !== expected.int('environmentRevision') ||
      env.tier !== expected.text('environmentTier')
    ) {
      changed.push({
        binding: 'environmentRevision',
        expected: expected.int('environmentRevision'),
        actual: env?.revision ?? null,
      })
    }
    const live = await liveTargetOf(store, c.text('projectId'), c.text('environmentId'))
    const expectedState = expected.textOrNull('targetState')
    if (
      (expectedState === null && live !== undefined) ||
      (expectedState !== null &&
        (live === undefined ||
          live.targetId !== c.text('targetId') ||
          live.state !== expectedState))
    ) {
      changed.push({ binding: 'targetState', expected: expectedState, actual: live?.state ?? null })
    }
    const database = await getDatabase(store, c.text('databaseId'))
    if (
      database === undefined ||
      database.state !== 'registered' ||
      database.placedTargetId !== expected.textOrNull('databasePlacedTarget')
    ) {
      changed.push({
        binding: 'databasePlacement',
        expected: expected.textOrNull('databasePlacedTarget'),
        actual: database?.placedTargetId ?? null,
      })
    }
    const cluster = await getCluster(store, c.text('clusterId'))
    if (
      cluster === undefined ||
      cluster.state !== 'active' ||
      cluster.systemIdentifier !== expected.text('systemIdentifier')
    ) {
      changed.push({
        binding: 'systemIdentifier',
        expected: expected.text('systemIdentifier'),
        actual: cluster?.systemIdentifier ?? null,
      })
    }
    const versions = expected.object('credentials')
    for (const role of ['observer', 'migrator'] as const) {
      const active = await activeCredential(store, c.text('clusterId'), role)
      if (active?.secretVersion !== versions.int(role)) {
        changed.push({
          binding: `credentials.${role}`,
          expected: versions.int(role),
          actual: active?.secretVersion ?? null,
        })
      }
    }
    return changed
  }

  /** Step 2: the registered target and its placement (idempotent for a resumed registration). */
  async #record(ctx: ExecutionContext, c: Body): Promise<'ok' | ExecutionOutcome> {
    const existing = await findTarget(this.deps.store, c.text('targetId'))
    if (existing !== undefined) {
      return existing.state === 'registered' &&
        existing.placement?.placementId === c.text('placementId')
        ? 'ok'
        : {
            outcome: 'not_applied',
            errorCode: 'REGISTRY_CONFLICT',
            detail: { reason: 'target_state' },
          }
    }
    const outcome = await this.effect(async (tx) => {
      await tx.query(
        'registry.kind.target.insert',
        `INSERT INTO registry.targets (target_id, project_id, environment_id, path, tier, generation, state,
                                       created_by_operation_id, state_changed_by_operation_id)
         VALUES ($1, $2, $3, $4, $5, 1, 'registered', $6, $6)`,
        [
          c.id('tgt', 'targetId'),
          c.id('prj', 'projectId'),
          c.id('env', 'environmentId'),
          c.text('path'),
          c.oneOf(['prod', 'nonprod'] as const, 'tier'),
          ctx.operationId,
        ],
      )
      await tx.query(
        'registry.kind.placement.insert',
        `INSERT INTO registry.placements (placement_id, target_id, database_id, generation, reason, operation_id)
         VALUES ($1, $2, $3, 1, 'initial', $4)`,
        [
          c.id('plc', 'placementId'),
          c.text('targetId'),
          c.id('dbs', 'databaseId'),
          ctx.operationId,
        ],
      )
      return true
    })
    return outcome === 'applied'
      ? 'ok'
      : outcome === 'not_applied'
        ? {
            outcome: 'not_applied',
            errorCode: 'REGISTRY_CONFLICT',
            detail: { reason: 'path_taken' },
          }
        : 'unknown'
  }

  /** Step 4 (and the engine's verification): a fresh observer session reads everything back. */
  async #readBack(c: Body, operationId: string | null): Promise<ReadBack> {
    const target = await findTarget(this.deps.store, c.text('targetId'))
    if (target === undefined) return { ok: false, reason: 'target_missing' }
    const opened = await this.deps.connector.forTarget(
      target,
      'observer',
      `register/${c.text('targetId')}`,
    )
    try {
      return await this.#compare(opened.session, c, operationId)
    } finally {
      await opened.session.close()
    }
  }

  async #compare(session: TargetSession, c: Body, operationId: string | null): Promise<ReadBack> {
    const marker = await readMarker(session)
    if (marker.status !== 'present') return { ok: false, reason: `marker_${marker.status}` }
    const m = marker.marker
    if (
      m.installationId !== c.text('installationId') ||
      m.targetId !== c.text('targetId') ||
      m.targetPath !== c.text('path') ||
      m.tier !== c.text('tier') ||
      m.generation !== c.int('generation') ||
      m.clusterSystemId !== c.text('systemIdentifier') ||
      (operationId !== null && m.stampedByOperation !== operationId && !c.bool('resumesTarget'))
    ) {
      return { ok: false, reason: 'marker_mismatch' }
    }
    if (!isEmptyLedger(await ledgerShape(session))) {
      return { ok: false, reason: 'ledger_shape' }
    }
    if (session.facts.systemIdentifier !== c.text('systemIdentifier')) {
      return { ok: false, reason: 'system_identifier' }
    }
    const oid = c.textOrNull('databaseOid')
    if (oid !== null) {
      const rows = await session.query(DATABASE_OID)
      if (rows[0]?.text('oid') !== oid) return { ok: false, reason: 'database_oid' }
    }
    return { ok: true }
  }

  async run(ctx: ExecutionContext, c: Body): Promise<ExecutionOutcome> {
    const oid = c.textOrNull('databaseOid')
    if (oid === null) {
      // A plan without an observed oid cannot prove which database it was made for.
      return {
        outcome: 'not_applied',
        errorCode: 'TARGET_REGISTRATION_REFUSED',
        detail: { reason: 'database_mismatch' },
      }
    }
    const stamp = {
      installationId: c.text('installationId'),
      targetId: c.text('targetId'),
      targetPath: c.text('path'),
      tier: c.oneOf(['prod', 'nonprod'] as const, 'tier'),
      generation: c.int('generation'),
      operationId: ctx.operationId,
      projectId: c.text('projectId'),
      databaseOid: oid,
    }

    // Step 1 opens the migrator session and takes the schema lock; every refusal of the
    // database (Control Store, another cluster or database, a foreign marker) happens
    // before anything is written, in the target or in the Control Store.
    let stamped: 'stamped' | 'already_stamped'
    let opened: Awaited<ReturnType<typeof this.deps.connector.open>>
    try {
      opened = await this.deps.connector.open({
        clusterId: c.text('clusterId'),
        database: c.text('databaseName'),
        role: 'migrator',
        purpose: `register/${c.text('targetId')}/${ctx.operationId}`,
      })
    } catch (error) {
      return refusalOf(error)
    }
    let writing = false
    try {
      // D11 again at execution: a cluster that hosts the Control Store is never managed,
      // even if it became one after planning.
      if (
        opened.session.facts.systemIdentifier === (await this.deps.controlStoreSystemIdentifier())
      ) {
        return {
          outcome: 'not_applied',
          errorCode: 'TARGET_REGISTRATION_REFUSED',
          detail: { reason: 'cluster_hosts_control_store' },
        }
      }
      const release = await takeSchemaLock(opened.session, c.text('targetId'))
      try {
        await preflightStamp(opened.session, stamp, c.text('systemIdentifier'))
        // Step 2: the registered target and its placement in the Control Store.
        const recorded = await this.#record(ctx, c)
        if (recorded !== 'ok') return recorded
        // Step 3: stamp (the preflight runs again inside, under the same lock).
        writing = true
        stamped = (await stampTarget(opened.session, stamp, c.text('systemIdentifier'))).status
      } finally {
        await release()
      }
    } catch (error) {
      if (error instanceof StampRefused) {
        return {
          outcome: 'not_applied',
          errorCode: 'TARGET_REGISTRATION_REFUSED',
          detail: { reason: error.reason },
        }
      }
      if (
        !writing ||
        (error instanceof TargetError && error.code === 'CLUSTER_IDENTITY_MISMATCH')
      ) {
        return refusalOf(error)
      }
      // The stamp transaction may or may not have committed: reconciliation reads the marker.
      return 'unknown'
    } finally {
      await opened.session.close()
    }

    // Step 4: read back on a fresh connection.
    let readBack: ReadBack
    try {
      readBack = await this.#readBack(c, stamped === 'stamped' ? ctx.operationId : null)
    } catch (error) {
      await this.#event(ctx.operationId, 'read_back_failed', { reason: failureClass(error) })
      return 'applied'
    }
    if (!readBack.ok) {
      await this.#event(ctx.operationId, 'read_back_failed', {
        reason: readBack.reason ?? 'unknown',
      })
      return 'applied'
    }

    // Step 5: the registration snapshot (and baseline when complete).
    let snapshot: Awaited<ReturnType<typeof this.deps.snapshots.capture>>
    try {
      snapshot = await this.deps.snapshots.capture({
        targetId: c.text('targetId'),
        generation: c.int('generation'),
        operationId: ctx.operationId,
      })
    } catch (error) {
      await this.#event(ctx.operationId, 'registration_snapshot_failed', {
        reason: failureClass(error),
      })
      return 'applied'
    }

    // Step 6: activate.
    const activated = await this.effect(async (tx) => {
      const { rowCount } = await tx.query(
        'registry.kind.target.activate',
        `UPDATE registry.targets SET state = 'active', state_changed_by_operation_id = $2
          WHERE target_id = $1 AND state = 'registered'`,
        [c.text('targetId'), ctx.operationId],
      )
      if (rowCount !== 1) return false
      await this.audit(
        tx,
        ctx,
        {
          databaseId: c.text('databaseId'),
          placementId: c.text('placementId'),
          generation: c.int('generation'),
          stamp: stamped,
          snapshotId: snapshot.snapshotId,
          fingerprint: snapshot.fingerprint,
          snapshotComplete: snapshot.complete,
          baseline: snapshot.baseline,
        },
        {
          targetId: c.text('targetId'),
          targetPath: c.text('path'),
          tier: c.oneOf(['prod', 'nonprod'] as const, 'tier'),
          clusterId: c.text('clusterId'),
        },
      )
      return true
    })
    if (activated === 'not_applied') {
      await this.#event(ctx.operationId, 'activation_refused', {})
    }
    // The marker is written either way; verification decides (a target that
    // is not active fails it and stays `registered`).
    return activated === 'unknown' ? 'unknown' : 'applied'
  }

  async #event(operationId: string, step: string, detail: Record<string, string>): Promise<void> {
    await this.deps.store
      .query(
        'registry.kind.target.event',
        `INSERT INTO operations.operation_events (operation_id, kind, detail)
         VALUES ($1, 'step_finished', jsonb_build_object('step', $2::text) || $3::jsonb)`,
        [operationId, step, JSON.stringify(detail)],
      )
      .catch(() => undefined)
  }

  async check(ctx: ExecutionContext, c: Body): Promise<boolean> {
    const target = await findTarget(this.deps.store, c.text('targetId'))
    if (target === undefined || target.state !== 'active') return false
    const back = await this.#readBack(c, null)
    if (!back.ok) return false
    return (await this.deps.snapshots.ofOperation(ctx.operationId)) !== undefined
  }

  async applied(ctx: ExecutionContext, c: Body): Promise<boolean> {
    const target = await findTarget(this.deps.store, c.text('targetId'))
    if (target === undefined) return false
    if (target.state === 'active') return true
    const opened = await this.deps.connector.forTarget(
      target,
      'observer',
      `reconcile/${ctx.operationId}`,
    )
    try {
      const marker = await readMarker(opened.session)
      return marker.status === 'present' && marker.marker.targetId === c.text('targetId')
    } finally {
      await opened.session.close()
    }
  }
}
