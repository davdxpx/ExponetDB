import { KindRegistry, type OperationKind, processNextOperation } from '@exponetdb/operations'
import type { RoleServices } from './role.ts'
import type { Runtime } from './runtime.ts'

/**
 * The worker's operations loop. Wave 2 registers no product kinds, so the
 * loop has nothing to claim and stays idle; the registry is where each later
 * wave adds its kinds. Operations of kinds this build does not know are never
 * claimed.
 */
export const PRODUCT_KINDS: readonly OperationKind[] = []

export function operationsLoop(services: RoleServices, runtime: Runtime, pollMs = 2000) {
  const kinds = new KindRegistry(PRODUCT_KINDS)
  const runs = runtime.metrics.counter<'outcome'>(
    'exdb_operations_loop_total',
    'Operations loop iterations by outcome.',
    {
      outcome: { values: ['idle', 'waiting', 'lease_lost', 'done', 'error'] },
    },
  )
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> = Promise.resolve()

  async function tick(): Promise<void> {
    if (stopped || kinds.names().length === 0) {
      return
    }
    try {
      const result = await processNextOperation(services.store, {
        workerId: services.processId,
        kinds,
        clock: runtime.clock,
      })
      runs.inc({ outcome: result.status })
    } catch (error) {
      runs.inc({ outcome: 'error' })
      runtime.logger.warn('operations.loop_failed', {
        code: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  return {
    start() {
      if (kinds.names().length === 0) {
        runtime.logger.info('operations.no_kinds_registered', { count: 0 })
        return
      }
      const loop = () => {
        running = tick().finally(() => {
          if (!stopped) {
            timer = setTimeout(loop, pollMs)
          }
        })
      }
      loop()
    },
    async stop() {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      await running
    },
  }
}
