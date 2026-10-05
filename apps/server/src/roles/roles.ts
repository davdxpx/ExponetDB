import { operationsLoop } from '../composition/operations-loop.ts'
import { liveWorkerCheck } from '../composition/role.ts'
import {
  checkpointExporter,
  maintenanceLoop,
  type TaskContext,
  workerChecks,
} from '../composition/worker-tasks.ts'
import type { GatewayConfig, ServeConfig, WorkerConfig } from '../config/env.ts'
import { type RoleRun, runRole } from './run-role.ts'

/**
 * The three process roles of one image ([ADR-0019](../../../../exponetdb-docs/01-architecture/adr/0019-process-roles-and-web-app.md)).
 *
 * - `serve`: the public listener (probes only in Wave 2: no management API)
 *   and the internal listener; heartbeat; readiness.
 * - `worker`: heartbeat, maintenance tasks (partitions, checkpoints and
 *   export, verification, expiry and pruning, key re-wrap), the operations
 *   loop (no product kinds in Wave 2).
 * - `gateway`: heartbeat and readiness only. It opens **no** agent listener
 *   before Wave 5 (an agent endpoint without mutual TLS would be an
 *   unauthenticated management endpoint) and its readiness never claims a CA
 *   or mTLS.
 */
type Hooks = Pick<RoleRun, 'until' | 'write' | 'onListening'>

export function runServe(config: ServeConfig, hooks: Hooks = {}): Promise<number> {
  return runRole({
    ...hooks,
    config,
    publicListen: config.listen,
    extraChecks: (services) => [liveWorkerCheck(services.store)],
  })
}

export function runWorker(config: WorkerConfig, hooks: Hooks = {}): Promise<number> {
  const exporter = checkpointExporter(config.auditExport)
  const state: TaskContext['state'] = { lastExportError: undefined, lastVerification: undefined }
  let ctx: TaskContext | undefined
  return runRole({
    ...hooks,
    config,
    extraChecks: (services, runtime) => {
      ctx = {
        store: services.store,
        runtime,
        keyring: services.keyring,
        installationId: config.installationId,
        exporter,
        state,
      }
      return workerChecks(ctx)
    },
    loops: async (services, runtime) => {
      const context = ctx ?? {
        store: services.store,
        runtime,
        keyring: services.keyring,
        installationId: config.installationId,
        exporter,
        state,
      }
      const maintenance = maintenanceLoop(context, services.processId)
      const operations = operationsLoop(services, runtime)
      maintenance.start()
      operations.start()
      return async () => {
        await operations.stop()
        await maintenance.stop()
      }
    },
  })
}

export function runGateway(config: GatewayConfig, hooks: Hooks = {}): Promise<number> {
  return runRole({ ...hooks, config })
}
