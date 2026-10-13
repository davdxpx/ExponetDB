import { isErrorCode } from '@exponetdb/contracts'
import { type DataReadOutcome, DataReadWorker, executeDataRead } from '@exponetdb/diagnostics'
import { isJsonObject, type JsonObject } from '@exponetdb/kernel'
import { describeError } from '@exponetdb/observability'
import { ConnectionBudget } from '@exponetdb/postgres'
import { type Connector, findTarget } from '@exponetdb/registry'
import type { RoleServices } from './role.ts'
import type { Runtime } from './runtime.ts'

/**
 * Reader sessions a worker opens per cluster at once for data reads
 * (ADR-0028 §2): within the worker's budget of 5, so migrations,
 * verification and observation always keep 3. A read waits for a slot at
 * most its statement timeout; the lane's deadline bounds it end to end.
 */
export const DATA_READ_SLOTS_PER_CLUSTER = 2

/**
 * The worker's data-read executor: the target from the registry, a fresh
 * `exponetdb_reader` session on its current placement (the worker's
 * credential; `serve` has none), the executor, and the session closed
 * whatever happens. Nothing here logs or measures a value.
 */
export function dataReadExecutor(
  services: Pick<RoleServices, 'store'>,
  connector: Connector,
  slots = new ConnectionBudget(DATA_READ_SLOTS_PER_CLUSTER),
) {
  return async (
    targetId: string,
    read: Parameters<typeof executeDataRead>[1],
    signal: AbortSignal,
  ): Promise<DataReadOutcome> => {
    const target = await findTarget(services.store, targetId)
    if (target === undefined) return { kind: 'refused', code: 'TARGET_NOT_FOUND' }
    if (target.placement === null) return { kind: 'refused', code: 'TARGET_UNAVAILABLE' }
    try {
      const release = await slots.acquire(
        target.placement.clusterId,
        read.statementTimeoutMs,
        signal,
      )
      try {
        const opened = await connector.forTarget(target, 'reader', `query/${read.requestId}`)
        try {
          return await executeDataRead(opened.session, read, signal)
        } finally {
          // A failing close never turns a finished read into an error.
          await opened.session.close().catch(() => undefined)
        }
      } finally {
        release()
      }
    } catch (error) {
      // Canceled while waiting for a slot or a connection: the caller's cancel, as it is.
      if (signal.aborted) return { kind: 'refused', code: 'QUERY_CANCELED' }
      // The registry's and the adapter's refusals (no reader credential, an unreachable
      // target) travel sealed with their details; anything else fails the read as INTERNAL.
      if (!(error instanceof Error) || !('code' in error)) throw error
      const code = error.code
      if (typeof code !== 'string' || !isErrorCode(code)) throw error
      const raw: unknown = 'details' in error ? error.details : undefined
      const details =
        raw !== undefined && isJsonObject(raw as never) ? (raw as JsonObject) : undefined
      return { kind: 'refused', code, ...(details === undefined ? {} : { details }) }
    }
  }
}

const counters = new WeakMap<Runtime['metrics'], ReturnType<typeof readCounter>>()

function readCounter(metrics: Runtime['metrics']) {
  return metrics.counter<'outcome'>(
    'exdb_data_reads_total',
    'Data reads the worker finished, by outcome.',
    { outcome: { values: ['done', 'failed', 'canceled'] } },
  )
}

/** The lane worker of this process: its key in memory, its reads, its metrics. */
export function dataReadWorker(
  services: Pick<RoleServices, 'store' | 'processId'>,
  runtime: Pick<Runtime, 'logger' | 'metrics'>,
  connector: Connector,
): DataReadWorker {
  // One counter per registry: a restarted lane (a new key) counts on.
  const finished = counters.get(runtime.metrics) ?? readCounter(runtime.metrics)
  counters.set(runtime.metrics, finished)
  return new DataReadWorker({
    store: services.store,
    workerId: services.processId,
    execute: dataReadExecutor(services, connector),
    onError: (event, error) => runtime.logger.warn(event, { ...describeError(error) }),
    onFinished: (outcome) => finished.inc({ outcome }),
  })
}
