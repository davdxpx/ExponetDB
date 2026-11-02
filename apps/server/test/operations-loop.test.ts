import type { ControlStore } from '@exponetdb/control-store'
import { systemClock } from '@exponetdb/kernel'
import { createLogger, fail, MetricsRegistry, pass, Readiness } from '@exponetdb/observability'
import type { OperationKind } from '@exponetdb/operations'
import { describe, expect, it } from 'vitest'
import { operationsLoop } from '../src/composition/operations-loop.ts'
import type { RoleServices } from '../src/composition/role.ts'
import type { Runtime } from '../src/composition/runtime.ts'

/**
 * VC-064: after `control-store migrate` of a newer build, an old worker was
 * not ready (schema newer) but kept claiming and finishing operations, with
 * no log line. The loop claims nothing while the schema is not this build's.
 */
const KIND = { kind: 'synthetic.loop' } as unknown as OperationKind

async function world(schema: 'pass' | 'fail') {
  const readiness = new Readiness(systemClock)
  readiness.register({
    name: 'schema',
    severity: 'critical',
    run: async () => (schema === 'pass' ? pass() : fail('schema_newer')),
  })
  await readiness.evaluate()
  let claims = 0
  const store = {
    transaction: async () => {
      claims += 1
      return undefined
    },
  } as unknown as ControlStore
  const lines: string[] = []
  const runtime = {
    clock: systemClock,
    metrics: new MetricsRegistry(),
    logger: createLogger({ role: 'worker', level: 'info', write: (l) => lines.push(l) }),
  } as unknown as Runtime
  const services = {
    store,
    processId: 'prc_01M6DV2NQJDYWP4GXT46DTRK2S',
    readiness,
  } as unknown as RoleServices
  const loop = operationsLoop(services, runtime, [KIND], async () => [], 5)
  return { loop, lines, claims: () => claims }
}

describe('the operations loop and the schema', () => {
  it('claims nothing while the schema is not this build’s, and says so once', async () => {
    const w = await world('fail')
    w.loop.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await w.loop.stop()
    expect(w.claims()).toBe(0)
    expect(w.lines.filter((l) => l.includes('operations.claim_paused'))).toHaveLength(1)
    expect(w.lines.find((l) => l.includes('operations.claim_paused'))).toContain('schema_newer')
  })

  it('claims when the schema is current', async () => {
    const w = await world('pass')
    w.loop.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await w.loop.stop()
    expect(w.claims()).toBeGreaterThan(0)
  })
})
