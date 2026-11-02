import type { HealthCheck } from '@exponetdb/observability'
import { SCHEMA_NEWER_REMEDY } from '../composition/commands.ts'
import { composeRole, type RoleServices } from '../composition/role.ts'
import { createRuntime, type Runtime } from '../composition/runtime.ts'
import { BUILD } from '../config/build-info.ts'
import type { RoleConfig } from '../config/env.ts'
import { createInternalApp, createPublicApp, httpMetrics } from '../interfaces/http/app.ts'
import { type Listener, listen, shutdown, shutdownSignal } from './lifecycle.ts'

/** After the drain: marking the heartbeat stopped and closing the pool and the internal listener. */
const SERVICES_STOP_MS = 5000

/**
 * Runs one process role until a shutdown signal (or `until`, in tests):
 * compose, refuse unsafe starts, open the listeners, run the role's loops,
 * then shut down in order. Returns the exit code.
 */
export interface RoleRun {
  readonly config: RoleConfig
  readonly publicListen?: { readonly host: string; readonly port: number }
  readonly extraChecks?: (
    services: Omit<RoleServices, 'start' | 'stop'>,
    runtime: Runtime,
  ) => readonly HealthCheck[]
  /** What the public listener serves besides the probes (serve: the Web App and its API). */
  readonly publicSurface?: (
    services: RoleServices,
    runtime: Runtime,
  ) => Promise<Parameters<typeof createPublicApp>[1]>
  /** Starts the role's own loops after the common services; returns their stop function. */
  readonly loops?: (services: RoleServices, runtime: Runtime) => Promise<() => Promise<void>>
  readonly until?: Promise<unknown>
  readonly write?: (line: string) => void
  readonly onListening?: (ports: { readonly public?: number; readonly internal: number }) => void
}

export async function runRole(run: RoleRun): Promise<number> {
  const { config } = run
  const runtime = createRuntime({
    role: config.role,
    logLevel: config.logLevel,
    otlpEndpoint: config.otlpEndpoint,
    ...(run.write === undefined ? {} : { write: run.write }),
  })
  const log = runtime.logger
  log.info('process.starting', { buildVersion: BUILD.version, buildCommit: BUILD.commit })
  // The image starts Node with --liftoff-only: without it V8 recompiles the PostgreSQL parser's
  // WebAssembly, which took hundreds of MiB outside the heap on a large legacy history and had
  // a 512 MiB container killed (deployment.md §2a). A start that overrides the entrypoint must
  // keep the flag; NODE_OPTIONS cannot carry it.
  if (!process.execArgv.includes('--liftoff-only')) {
    log.warn('process.wasm_tier_up_enabled', { expectedNodeFlag: '--liftoff-only' })
  }
  let services: RoleServices
  try {
    services = await composeRole(config, runtime, {
      ...(run.extraChecks === undefined
        ? {}
        : { extraChecks: (s) => run.extraChecks?.(s, runtime) ?? [] }),
    })
    await services.start()
  } catch (error) {
    const code =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'startup_failed'
    log.error('process.start_refused', {
      reason: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'startup_failed',
      // VC-065: an older image against a store a newer build migrated: never run it, say what to do.
      ...(code === 'schema_newer' ? { remedy: SCHEMA_NEWER_REMEDY } : {}),
    })
    await runtime.tracing.shutdown(2000)
    return 3
  }
  const http = httpMetrics(runtime.metrics)
  const deps = {
    readiness: () => services.readiness.latest(),
    version: BUILD.version,
    logger: log,
    metrics: http,
    clock: runtime.clock,
    tracing: runtime.tracing,
  }
  const internal = await listen(
    createInternalApp({ ...deps, registry: runtime.metrics }).fetch,
    config.internalListen,
  )
  let publicListener: Listener | undefined
  if (run.publicListen !== undefined) {
    const surface = (await run.publicSurface?.(services, runtime)) ?? {}
    publicListener = await listen(createPublicApp(deps, surface).fetch, run.publicListen)
  }
  run.onListening?.({
    internal: internal.port,
    ...(publicListener === undefined ? {} : { public: publicListener.port }),
  })
  const stopLoops = (await run.loops?.(services, runtime)) ?? (async () => undefined)
  log.info('process.started', {
    processId: services.processId,
    port: publicListener?.port ?? internal.port,
    state: services.readiness.latest().status,
  })

  await (run.until ?? shutdownSignal(log))

  const finished = await shutdown(
    {
      markStopping: () => services.readiness.markStopping(),
      closePublic: async () => publicListener?.close(config.shutdownTimeoutMs / 2),
      stopLoops,
      stopServices: () => services.stop(),
      closeInternal: () => internal.close(1000),
    },
    { drainMs: config.shutdownTimeoutMs, afterMs: SERVICES_STOP_MS },
  )
  await runtime.tracing.shutdown(2000)
  log.info('process.stopped', { ok: finished })
  return finished ? 0 : 1
}
