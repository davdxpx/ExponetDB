import type { ControlStore, Tx } from '@exponetdb/control-store'
import { type MigratedTestDatabase, migratedTestDatabase } from '@exponetdb/control-store/testing'
import { type IdentityId, newId, systemClock } from '@exponetdb/kernel'
import {
  acceptPlan,
  KindRegistry,
  type OperationActor,
  type OperationRecord,
  type PlanRecord,
  processNextOperation,
  readOperation,
} from '@exponetdb/operations'
import { REGISTRY_RULES, RuleRegistry } from '@exponetdb/policy'
import {
  clusterBootstrapStatements,
  databaseBootstrapStatements,
  passwordStatements,
  ROLE_NAMES,
} from '@exponetdb/postgres'
import {
  generateKeyringText,
  type Keyring,
  parseKeyring,
  registerActiveKey,
} from '@exponetdb/secrets'
import {
  createDatabase,
  loginPassword,
  provisionRoles,
  runAsSuperuser,
  type TestServer,
  testTargets,
} from '@exponetdb/testkit'
import {
  Connector,
  type RegistrationSnapshots,
  type RegistryActor,
  type RegistryPlanContext,
  registryKinds,
  submitCredential,
  verifyPendingCredentials,
} from '../src/index.ts'

/**
 * Test glue for the registry against real PostgreSQL: a migrated Control
 * Store (PostgreSQL 17, EXDB_TEST_PG_URL) and the TLS test servers
 * (EXDB_TEST_TARGETS, PostgreSQL 16, 17, 18), ExponetDB's roles from the
 * product bootstrap SQL, the real Operations Engine with the registry kinds
 * and a recording registration-snapshot port (diagnostics owns the real
 * one; its tests cover snapshot storage).
 */
export interface Harness {
  readonly db: MigratedTestDatabase
  readonly serve: ControlStore
  readonly worker: ControlStore
  readonly keyring: Keyring
  readonly serveConnector: Connector
  readonly workerConnector: Connector
  readonly context: RegistryPlanContext
  readonly kinds: KindRegistry
  readonly snapshots: RecordingSnapshots
  readonly controlStoreSystemIdentifier: string
  close(): Promise<void>
}

export class RecordingSnapshots implements RegistrationSnapshots {
  readonly taken = new Map<string, { snapshotId: string; targetId: string }>()
  fail = false

  async capture(input: { targetId: string; generation: number; operationId: string }) {
    if (this.fail) throw new Error('snapshot failed (test)')
    const snapshotId = newId('smp', Date.now())
    this.taken.set(input.operationId, { snapshotId, targetId: input.targetId })
    return { snapshotId, fingerprint: `fp1:17:${'0'.repeat(64)}`, complete: true, baseline: true }
  }

  async ofOperation(operationId: string) {
    const s = this.taken.get(operationId)
    return s === undefined ? undefined : { snapshotId: s.snapshotId }
  }
}

export const actor = (label = 'human #1'): RegistryActor => ({
  identityId: newId('idn', Date.now()) as IdentityId,
  label,
  reauthAt: new Date().toISOString(),
  client: 'web',
})

export async function harness(prefix = 'exdb_it_registry'): Promise<Harness> {
  const db = await migratedTestDatabase(prefix)
  const serve = db.store('exdb_serve')
  const worker = db.store('exdb_worker')
  const parsed = parseKeyring(generateKeyringText('k1'))
  if (!parsed.ok) throw new Error('test keyring')
  const keyring = parsed.value
  await registerActiveKey(worker, keyring)
  const sysid = (
    await worker.query(
      'test.cs.sysid',
      'SELECT system_identifier::text AS s FROM pg_catalog.pg_control_system()',
    )
  ).rows[0]?.text('s')
  if (sysid === undefined) throw new Error('control store system identifier')
  const serveConnector = new Connector(serve, { keyring, process: 'serve' })
  const workerConnector = new Connector(worker, { keyring, process: 'worker' })
  const snapshots = new RecordingSnapshots()
  const context: RegistryPlanContext = {
    policy: {
      registry: new RuleRegistry(REGISTRY_RULES),
      codeVersion: '0.1.0+test',
      clock: systemClock,
    },
    installationId: db.installationId,
    connector: serveConnector,
    controlStoreSystemIdentifier: async () => sysid,
  }
  const kinds = new KindRegistry(
    registryKinds({
      store: worker,
      clock: systemClock,
      connector: workerConnector,
      installationId: db.installationId,
      controlStoreSystemIdentifier: async () => sysid,
      snapshots,
    }),
  )
  return {
    db,
    serve,
    worker,
    keyring,
    serveConnector,
    workerConnector,
    context,
    kinds,
    snapshots,
    controlStoreSystemIdentifier: sysid,
    close: () => db.drop(),
  }
}

export function plan<T>(h: Harness, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return h.serve.transaction('test.registry.plan', fn)
}

const operationActorOf = (a: RegistryActor): OperationActor => ({
  kind: 'human',
  identityId: a.identityId,
  label: a.label,
  client: 'web',
  clientId: null,
})

/** Accepts a plan as its actor (re-authentication counts as fresh), like `plan.apply`. */
export async function accept(
  h: Harness,
  p: PlanRecord,
  by: RegistryActor,
): Promise<OperationRecord> {
  const result = await h.serve.transaction('test.registry.accept', (tx) =>
    acceptPlan(
      tx,
      { planId: p.planId, actor: operationActorOf(by) },
      {
        kinds: h.kinds,
        clock: systemClock,
        systemActor: {
          kind: 'system',
          identityId: null,
          label: 'system:serve',
          client: 'system',
          clientId: null,
        },
        recheckPolicy: async () => ({ status: 'proceed', requirements: [] }),
        requirementMet: async (r) => r.kind === 'reauth',
      },
    ),
  )
  if (result.status !== 'accepted') throw result.error
  return result.operation
}

/** Runs the worker loop until nothing is left to do. */
export async function drive(h: Harness): Promise<void> {
  const workerId = newId('prc', Date.now())
  for (let i = 0; i < 50; i++) {
    const r = await processNextOperation(h.worker, { workerId, kinds: h.kinds, clock: systemClock })
    if (r.status === 'idle') return
  }
  throw new Error('the worker did not become idle')
}

/** Plan, apply as the planner, execute: the operation as it ended. */
export async function run(
  h: Harness,
  by: RegistryActor,
  make: (tx: Tx) => Promise<PlanRecord>,
): Promise<{ plan: PlanRecord; operation: OperationRecord }> {
  const p = await plan(h, make)
  const accepted = await accept(h, p, by)
  await drive(h)
  const operation = await readOperation(h.worker, accepted.operationId)
  if (operation === undefined) throw new Error('operation vanished')
  return { plan: p, operation }
}

/** The error code an operation failed with (from its transition events). */
export async function operationError(
  h: Harness,
  operationId: string,
): Promise<{ code: string | null; reason: string | null }> {
  const { rows } = await h.worker.query(
    'test.registry.op_error',
    `SELECT detail->>'errorCode' AS code, detail->>'reason' AS reason FROM operations.operation_events
      WHERE operation_id = $1 AND detail ? 'errorCode' ORDER BY event_id DESC LIMIT 1`,
    [operationId],
  )
  return {
    code: rows[0]?.textOrNull('code') ?? null,
    reason: rows[0]?.textOrNull('reason') ?? null,
  }
}

/** ExponetDB's roles on a test server, created with the product bootstrap SQL. */
export async function ensureRoles(server: TestServer): Promise<void> {
  await provisionRoles(server, {
    roles: ROLE_NAMES,
    cluster: (v) => clusterBootstrapStatements(v),
    passwords: (v) => passwordStatements(v),
  })
}

/** A fresh database with the per-database bootstrap grants. */
export async function targetDatabase(
  server: TestServer,
  label: string,
  extra: readonly string[] = [],
): Promise<string> {
  await ensureRoles(server)
  const name = await createDatabase(server, label)
  await runAsSuperuser(server, name, [...databaseBootstrapStatements(name), ...extra])
  return name
}

export const password = (role: keyof typeof ROLE_NAMES) => loginPassword(ROLE_NAMES[role])

/** Submits a credential the way the write-only endpoint does. */
export function submit(
  h: Harness,
  by: RegistryActor,
  clusterId: string,
  role: keyof typeof ROLE_NAMES,
  pw = password(role),
) {
  return plan(h, (tx) =>
    submitCredential(tx, { keyring: h.keyring, clock: systemClock }, by, {
      clusterId,
      role,
      password: pw,
    }),
  )
}

export function verifyCredentials(h: Harness) {
  return verifyPendingCredentials({
    store: h.worker,
    connector: h.workerConnector,
    clock: systemClock,
  })
}

export const targets = testTargets

/** An endpoint request for a test server: by IP with the certificate's DNS name, or by `localhost`. */
export function endpointFor(server: TestServer, via: 'ip' | 'localhost' = 'ip') {
  return via === 'ip'
    ? {
        kind: 'private' as const,
        host: server.host === 'localhost' ? '127.0.0.1' : server.host,
        port: server.port,
        tlsServerName: testTargets().serverName,
        label: `pg${server.major}`,
      }
    : {
        kind: 'private' as const,
        host: 'localhost',
        port: server.port,
        label: `pg${server.major}-local`,
      }
}
