import type { ControlStore } from '@exponetdb/control-store'
import {
  dueDriftTargets,
  maintainSamplePartitions,
  RegistrationSnapshotStore,
  runDriftCheck,
  sampleTarget,
  targetsToSample,
} from '@exponetdb/diagnostics'
import type { Clock } from '@exponetdb/kernel'
import { describeError, type Logger } from '@exponetdb/observability'
import { KindRegistry, type OperationKind, WORKER_ACTOR } from '@exponetdb/operations'
import { RuleRegistry } from '@exponetdb/policy'
import { CircuitBreaker, ConnectionBudget } from '@exponetdb/postgres'
import {
  Connector,
  findTarget,
  type RegistryAcceptContext,
  type RegistryPolicyContext,
  registryKinds,
  suspendForIdentityMismatch,
  verifyPendingCredentials,
} from '@exponetdb/registry'
import type { Keyring } from '@exponetdb/secrets'

/**
 * Wave 4 composition: the target registry and diagnostics for each process
 * role ([package-architecture.md](../../../../exponetdb-docs/01-architecture/package-architecture.md)).
 *
 * - Each process has one connection budget per cluster, shared by every
 *   connector it creates (operation sessions, observation reads and health
 *   probes alike): serve 3 and the worker 5, so the installation never
 *   holds more than the documented 8 connections on a cluster (G4 record
 *   §5, D4). Sessions that serve requests or execute operations also have
 *   a circuit breaker per endpoint; the health sampler's connector has
 *   none: it measures, so a failing path is reported, not skipped.
 * - `serve` reads observer secrets only; the worker reads every role's.
 * - The Control Store's own `system_identifier` is read from its login:
 *   a cluster that hosts it is never managed.
 */
export interface RegistryRuntime {
  readonly store: ControlStore
  readonly keyring: Keyring
  readonly clock: Clock
  readonly installationId: string
}

export function controlStoreSystemIdentifier(store: ControlStore): () => Promise<string> {
  let cached: string | undefined
  return async () => {
    if (cached !== undefined) return cached
    const { rows } = await store.query(
      'registry.control_store.system_identifier',
      'SELECT system_identifier::text AS s FROM pg_catalog.pg_control_system()',
    )
    const value = rows[0]?.text('s')
    if (value === undefined) throw new Error('the Control Store system identifier is unreadable')
    cached = value
    return value
  }
}

/** Connections per cluster of each process role; the sum is the installation's limit (8). */
export const CLUSTER_CONNECTIONS = { serve: 3, worker: 5 } as const

/** One budget per process, keyed by the process's own Control Store login. */
const budgets = new WeakMap<ControlStore, ConnectionBudget>()

export function processBudget(rt: RegistryRuntime, process: 'serve' | 'worker'): ConnectionBudget {
  let budget = budgets.get(rt.store)
  if (budget === undefined) {
    budget = new ConnectionBudget(CLUSTER_CONNECTIONS[process])
    budgets.set(rt.store, budget)
  } else if (budget.limit !== CLUSTER_CONNECTIONS[process]) {
    throw new Error('one Control Store login serves one process role')
  }
  return budget
}

export function connectorFor(
  rt: RegistryRuntime,
  process: 'serve' | 'worker',
  options: { readonly breaker: boolean },
): Connector {
  return new Connector(rt.store, {
    keyring: rt.keyring,
    process,
    budget: processBudget(rt, process),
    ...(options.breaker ? { breaker: new CircuitBreaker() } : {}),
  })
}

/** The registry kinds of a process (serve: acceptance checks only; the worker executes). */
export function registryKindsFor(
  rt: RegistryRuntime,
  connector: Connector,
): readonly OperationKind[] {
  return registryKinds({
    store: rt.store,
    clock: rt.clock,
    connector,
    installationId: rt.installationId,
    controlStoreSystemIdentifier: controlStoreSystemIdentifier(rt.store),
    snapshots: new RegistrationSnapshotStore({
      store: rt.store,
      connector,
      installationId: rt.installationId,
    }),
  })
}

export function registryPolicy(
  rules: RuleRegistry | ConstructorParameters<typeof RuleRegistry>[0],
  codeVersion: string,
  clock: Clock,
): RegistryPolicyContext {
  return {
    registry: rules instanceof RuleRegistry ? rules : new RuleRegistry(rules),
    codeVersion,
    clock,
  }
}

/** The worker's observation tasks (registered with the maintenance loop). */
export interface ObservationTasks {
  /** Verifies pending credentials by logging in with them. */
  verifyCredentials(): Promise<string | undefined>
  /** One health sample of every active or suspended target (bounded concurrency). */
  sampleHealth(): Promise<string | undefined>
  /** Scheduled drift checks of the targets that are due. */
  checkDrift(): Promise<string | undefined>
  /** Health sample partitions ahead and expired ones dropped. */
  partitions(): Promise<string | undefined>
}

export function observationTasks(
  rt: RegistryRuntime,
  accept: RegistryAcceptContext,
  logger: Pick<Logger, 'warn'>,
  options: { readonly sampleConcurrency?: number; readonly retentionDays?: number } = {},
): ObservationTasks {
  const operations = connectorFor(rt, 'worker', { breaker: true })
  const probes = connectorFor(rt, 'worker', { breaker: false })
  const deps = { store: rt.store, connector: operations, installationId: rt.installationId }
  return {
    async verifyCredentials() {
      await verifyPendingCredentials({ store: rt.store, connector: operations, clock: rt.clock })
      return undefined
    },
    async sampleHealth() {
      const ids = await targetsToSample(rt.store)
      const limit = Math.max(1, options.sampleConcurrency ?? 8)
      let next = 0
      const worker = async () => {
        for (;;) {
          const id = ids[next++]
          if (id === undefined) return
          const target = await findTarget(rt.store, id)
          if (target === undefined) continue
          await sampleTarget(
            {
              store: rt.store,
              connector: probes,
              installationId: rt.installationId,
              suspend: (targetId, observed) =>
                suspendForIdentityMismatch(rt.store, accept, targetId, observed),
            },
            target,
          ).catch((error: unknown) => {
            // One target's failure never stops the others; the next sample tries again.
            logger.warn('health.sample_failed', { targetId: id, ...describeError(error) })
          })
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker))
      return ids.length === 0 ? 'no_targets' : undefined
    },
    async checkDrift() {
      const due = await dueDriftTargets(rt.store, 10)
      for (const id of due) {
        const target = await findTarget(rt.store, id)
        if (target === undefined) continue
        await runDriftCheck(deps, target, 'schedule')
      }
      return due.length === 0 ? 'none_due' : undefined
    },
    async partitions() {
      await maintainSamplePartitions(rt.store, options.retentionDays ?? 14)
      return undefined
    },
  }
}

/** The worker's observation tasks with the system's acceptance context (its own kinds and the policy rules). */
export function workerObservation(
  rt: RegistryRuntime,
  kinds: readonly OperationKind[],
  rules: ConstructorParameters<typeof RuleRegistry>[0],
  codeVersion: string,
  logger: Pick<Logger, 'warn'>,
): ObservationTasks {
  return observationTasks(
    rt,
    {
      policy: registryPolicy(rules, codeVersion, rt.clock),
      kinds: new KindRegistry(kinds),
      systemActor: WORKER_ACTOR,
    },
    logger,
  )
}
