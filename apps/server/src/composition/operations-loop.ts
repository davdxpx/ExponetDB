import {
  type DispatchAdmission,
  KindRegistry,
  type OperationKind,
  processNextOperation,
} from '@exponetdb/operations'
import type { RoleServices } from './role.ts'
import type { Runtime } from './runtime.ts'

/**
 * The worker's operations loop over the kinds this build registers (Wave
 * 3A: the access kinds). Operations of kinds this build does not know are
 * never claimed. `admit` is the dispatch admission (Wave 5 correction F2).
 */
export function operationsLoop(
  services: RoleServices,
  runtime: Runtime,
  productKinds: readonly OperationKind[],
  admit: DispatchAdmission,
  pollMs = 2000,
) {
  const kinds = new KindRegistry(productKinds)
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
        admit,
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
