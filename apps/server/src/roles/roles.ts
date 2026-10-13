import {
  type AccessComposition,
  codeVersion,
  composeAccess,
  loadWebAssets,
  POLICY_RULES,
  workerDispatchAdmission,
  workerKinds,
} from '../composition/access.ts'
import { dataReadWorker } from '../composition/data-read.ts'
import { composeGateway, type GatewayComposition } from '../composition/gateway.ts'
import { operationsLoop } from '../composition/operations-loop.ts'
import { connectorFor, workerObservation } from '../composition/registry.ts'
import { liveWorkerCheck } from '../composition/role.ts'
import {
  checkpointExporter,
  maintenanceLoop,
  type TaskContext,
  workerChecks,
} from '../composition/worker-tasks.ts'
import { BUILD } from '../config/build-info.ts'
import type { GatewayConfig, ServeConfig, WorkerConfig } from '../config/env.ts'
import { createCursorCodec } from '../interfaces/mcp/cursor.ts'
import { mcpMetrics } from '../interfaces/mcp/edge.ts'
import { createToolHost } from '../interfaces/mcp/registry.ts'
import { createRequestStateCodec } from '../interfaces/mcp/request-state.ts'
import { createResourceHost } from '../interfaces/mcp/resources.ts'
import { type RoleRun, runRole } from './run-role.ts'

/**
 * The three process roles of one image ([ADR-0019](../../../../exponetdb-docs/01-architecture/adr/0019-process-roles-and-web-app.md)).
 *
 * - `serve`: the public listener (probes; since Wave 3A the Web App, its
 *   `/auth` ceremonies and the `/api/v1` access resources; since Wave 7
 *   `POST /mcp`) and the internal
 *   listener; heartbeat; readiness, including the role-matrix check.
 * - `worker`: heartbeat, maintenance tasks (partitions, checkpoints and
 *   export, verification, expiry and pruning, key re-wrap), the operations
 *   loop (since Wave 3A: the access kinds), the data-read lane (Wave 7).
 * - `gateway`: heartbeat, readiness and, with `EXPONETDB_GATEWAY_LISTEN`
 *   (Wave 5), the agent listener: HTTP/2 over TLS 1.3 with client
 *   certificates, opened only once the agent PKI exists; never a listener
 *   without mutual TLS.
 */
type Hooks = Pick<RoleRun, 'until' | 'write' | 'onListening'>

export function runServe(
  config: ServeConfig,
  hooks: Hooks & { readonly webDirectories?: readonly string[] } = {},
): Promise<number> {
  let access: AccessComposition | undefined
  const { webDirectories, ...roleHooks } = hooks
  return runRole({
    ...roleHooks,
    config,
    publicListen: config.listen,
    extraChecks: (services, runtime) => {
      access = composeAccess(config, services, runtime)
      return [liveWorkerCheck(services.store), access.roleCatalogCheck, access.scopeCatalogCheck]
    },
    publicSurface: async (services, runtime) => {
      const composed = access ?? composeAccess(config, services, runtime)
      const web = await loadWebAssets(webDirectories)
      if (web === undefined) {
        runtime.logger.warn('web.assets_missing', { count: 0 })
      }
      const cursors = createCursorCodec(() => composed.auth.keys.mcpKey('mcp.cursor_key'))
      return {
        api: {
          application: composed.application,
          publicOrigin: config.publicUrl,
          trustedProxies: config.trustedProxies,
          logger: runtime.logger,
          available: composed.available,
        },
        mcp: {
          application: composed.application,
          tools: createToolHost(composed.application, runtime.logger, {
            cursors,
            states: createRequestStateCodec(() =>
              composed.auth.keys.mcpKeys('mcp.request_state_key'),
            ),
          }),
          resources: createResourceHost(composed.application, runtime.logger, cursors),
          publicOrigin: config.publicUrl,
          extraOrigins: config.mcpAllowedOrigins,
          version: BUILD.version,
          logger: runtime.logger,
          metrics: mcpMetrics(runtime.metrics),
          available: composed.available,
          pseudonymizer: () => composed.auth.keys.pseudonymizer(),
        },
        ...(web === undefined ? {} : { web }),
      }
    },
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
      const kinds = workerKinds(services, runtime, config.installationId)
      const observation = workerObservation(
        {
          store: services.store,
          keyring: services.keyring,
          clock: runtime.clock,
          installationId: config.installationId,
        },
        kinds,
        POLICY_RULES,
        codeVersion(),
        runtime.logger,
      )
      const context = {
        ...(ctx ?? {
          store: services.store,
          runtime,
          keyring: services.keyring,
          installationId: config.installationId,
          exporter,
          state,
        }),
        observation,
      }
      const maintenance = maintenanceLoop(context, services.processId)
      const operations = operationsLoop(
        services,
        runtime,
        kinds,
        workerDispatchAdmission(kinds, runtime),
      )
      // Data reads (ADR-0028): the worker's own key, reader sessions from its connector.
      const reads = dataReadWorker(
        services,
        runtime,
        connectorFor(
          {
            store: services.store,
            keyring: services.keyring,
            clock: runtime.clock,
            installationId: config.installationId,
          },
          'worker',
          { breaker: true },
        ),
      )
      maintenance.start()
      operations.start()
      await reads.start()
      return async () => {
        await reads.stop()
        await operations.stop()
        await maintenance.stop()
      }
    },
  })
}

export function runGateway(config: GatewayConfig, hooks: Hooks = {}): Promise<number> {
  let gateway: GatewayComposition | undefined
  return runRole({
    ...hooks,
    config,
    extraChecks: (services, runtime) => {
      gateway = composeGateway(config, services, runtime)
      return [gateway.check]
    },
    loops: async (services, runtime) => {
      const composed = gateway ?? composeGateway(config, services, runtime)
      await composed.start()
      return () => composed.stop()
    },
  })
}
