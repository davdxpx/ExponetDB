import type { AddressInfo } from 'node:net'
import type { Logger } from '@exponetdb/observability'
import { serve } from '@hono/node-server'

/**
 * Process lifecycle shared by the three roles: listeners and graceful
 * shutdown ([deployment.md §3](../../../../exponetdb-docs/12-operations/deployment.md#3-startup-and-readiness)).
 *
 * On SIGTERM or SIGINT a role first turns not ready, then stops accepting
 * new work, lets in-flight work finish within the shutdown timeout, marks its
 * heartbeat stopped and closes its pool. A second signal, or the timeout,
 * ends the process with a non-zero exit code.
 */
export interface Listener {
  readonly port: number
  close(timeoutMs: number): Promise<void>
}

/**
 * Read deadlines against slow clients (Wave 7 order §30): the request head
 * must arrive within `headersMs` and the whole request within `requestMs`,
 * checked every `checkMs`; an idle keep-alive connection closes after
 * `keepAliveMs`. A response (a stream included) is not bounded by them. The
 * `/mcp` edge adds its own, tighter body deadline (ADR-0027 §3).
 */
export interface ListenDeadlines {
  readonly headersMs: number
  readonly requestMs: number
  readonly checkMs: number
  readonly keepAliveMs: number
  /** Open connections at once; past it a connection is closed at once (VC-078). */
  readonly maxConnections: number
}

export const LISTEN_DEADLINES: ListenDeadlines = {
  headersMs: 20_000,
  requestMs: 120_000,
  checkMs: 2_000,
  keepAliveMs: 5_000,
  // About 1,100 descriptors and 143 MB were held by an unauthenticated flood without a cap.
  maxConnections: 1024,
}

export async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  endpoint: { readonly host: string; readonly port: number },
  deadlines: ListenDeadlines = LISTEN_DEADLINES,
): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch,
        hostname: endpoint.host,
        port: endpoint.port,
        serverOptions: {
          headersTimeout: deadlines.headersMs,
          requestTimeout: deadlines.requestMs,
          connectionsCheckingInterval: deadlines.checkMs,
          keepAliveTimeout: deadlines.keepAliveMs,
        },
      },
      (info: AddressInfo) => {
        server.maxConnections = deadlines.maxConnections
        resolve({
          port: info.port,
          close: (timeoutMs) =>
            new Promise<void>((done) => {
              const timer = setTimeout(() => {
                if ('closeAllConnections' in server) {
                  server.closeAllConnections()
                }
                done()
              }, timeoutMs)
              timer.unref()
              server.close(() => {
                clearTimeout(timer)
                done()
              })
              if ('closeIdleConnections' in server) {
                server.closeIdleConnections()
              }
            }),
        })
      },
    )
    server.once('error', reject)
  })
}

/** Resolves on the first SIGTERM or SIGINT; a second signal exits at once. */
export function shutdownSignal(logger: Logger): Promise<string> {
  return new Promise((resolve) => {
    let received = false
    const handler = (signal: NodeJS.Signals) => {
      if (received) {
        logger.warn('process.forced_exit', { reason: signal.toLowerCase() })
        process.exit(130)
      }
      received = true
      logger.info('process.stopping', { reason: signal.toLowerCase() })
      resolve(signal)
    }
    process.on('SIGTERM', handler)
    process.on('SIGINT', handler)
  })
}

export interface ShutdownSteps {
  markStopping(): void
  closePublic(): Promise<void>
  /** Stops claiming and lets the running step finish (the drain). */
  stopLoops(): Promise<void>
  /** Marks the heartbeat stopped, closes the pool, wipes the keyring. */
  stopServices(): Promise<void>
  closeInternal(): Promise<void>
}

/**
 * A role's shutdown on SIGTERM (VC-043): not ready at once, no new claims, the running step
 * drains within `drainMs`. The services stop also when the drain ran out (the heartbeat is
 * marked stopped; a step cut short is reconciled after the restart), each within `afterMs`.
 * True when everything finished in time.
 */
export async function shutdown(
  steps: ShutdownSteps,
  options: { readonly drainMs: number; readonly afterMs: number },
): Promise<boolean> {
  steps.markStopping()
  const drained = await bounded(async () => {
    await steps.closePublic()
    await steps.stopLoops()
  }, options.drainMs)
  const stopped = await bounded(async () => {
    await steps.stopServices()
    await steps.closeInternal()
  }, options.afterMs)
  return drained && stopped
}

/** Runs `steps` bounded by `timeoutMs`; reports whether they finished in time. */
export async function bounded(steps: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref()
  })
  try {
    return await Promise.race([steps().then(() => true as const), timeout])
  } finally {
    clearTimeout(timer)
  }
}
