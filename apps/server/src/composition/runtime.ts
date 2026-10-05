import { ControlStore, type ControlStoreRole, controlStoreMetrics } from '@exponetdb/control-store'
import { type Clock, systemClock } from '@exponetdb/kernel'
import {
  createLogger,
  type Logger,
  type LogLevel,
  MetricsRegistry,
  type ProcessRole,
  setupTracing,
  type Tracing,
} from '@exponetdb/observability'
import { BUILD } from '../config/build-info.ts'

/**
 * The composition root's shared pieces: one logger, one metrics registry,
 * tracing (enabled only with an OTLP endpoint) and one Control Store pool
 * for the process's own login. Nothing else in the program constructs these.
 */
export interface Runtime {
  readonly role: ProcessRole
  readonly logger: Logger
  readonly metrics: MetricsRegistry
  readonly tracing: Tracing
  readonly clock: Clock
}

export function createRuntime(options: {
  readonly role: ProcessRole
  readonly logLevel: LogLevel
  readonly otlpEndpoint: string | undefined
  readonly clock?: Clock
  readonly write?: (line: string) => void
}): Runtime {
  const clock = options.clock ?? systemClock
  const logger = createLogger({
    role: options.role,
    level: options.logLevel,
    clock,
    ...(options.write === undefined ? {} : { write: options.write }),
  })
  const metrics = new MetricsRegistry()
  metrics
    .gauge('exdb_build_info', 'Build of this process (always 1).', {
      role: { values: ['serve', 'worker', 'gateway', 'migrate', 'cli'] },
    })
    .set({ role: options.role }, 1)
  const tracing = setupTracing({
    serviceName: 'exponetdb',
    role: options.role,
    version: BUILD.version,
    ...(options.otlpEndpoint === undefined ? {} : { otlpEndpoint: options.otlpEndpoint }),
  })
  return { role: options.role, logger, metrics, tracing, clock }
}

export function openStore(
  runtime: Runtime,
  url: string,
  login: ControlStoreRole,
  poolMax = 10,
): ControlStore {
  return new ControlStore({
    url,
    role: login,
    applicationName: `exponetdb-${runtime.role}`,
    poolMax,
    observer: controlStoreMetrics(runtime.metrics),
    tracing: runtime.tracing,
    onPoolError: (error) =>
      runtime.logger.warn('control_store.pool_error', {
        code: error.code,
        ...(error.sqlstate === undefined ? {} : { sqlstate: error.sqlstate }),
      }),
  })
}
