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

export async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  endpoint: { readonly host: string; readonly port: number },
): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch, hostname: endpoint.host, port: endpoint.port },
      (info: AddressInfo) => {
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
