import type { ControlStore } from '@exponetdb/control-store'
import { describe, expect, it } from 'vitest'
import { refreshCatalogsAsSystem } from '../src/auto-refresh.ts'

const A = 'cls_01M5X840BJSCYX2JZ3HYCMHDBA'
const B = 'cls_01M5X840BJSCYX2JZ3HYCMHDBB'

const row = (value: string) => ({ text: () => value })

/**
 * A store whose first cluster's transaction fails with a store error and whose second
 * cluster already has an open refresh (so nothing is planned for it and no planner runs).
 */
function store(): ControlStore {
  return {
    query: async () => ({ rows: [row(A), row(B)] }),
    transaction: async (_name: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: async (name: string, _sql: string, params: unknown[]) => {
          if (name === 'backups.system_refresh.open') {
            return { rows: params[0] === B ? [row('1')] : [] }
          }
          if (name === 'backups.system_refresh.lock' && failing) {
            failing = false
            throw new Error('connection terminated')
          }
          return { rows: [] }
        },
      }),
  } as unknown as ControlStore
}
let failing = true

describe("the worker's own catalog refresh (OD-73)", () => {
  it('one cluster that fails never stops the others: it is reported, the next one is checked', async () => {
    failing = true
    const pass = await refreshCatalogsAsSystem(store(), { plan: {}, accept: {} } as never)
    expect(pass.failed.map((f) => [f.clusterId, (f.error as Error).message])).toEqual([
      [A, 'connection terminated'],
    ])
    expect(pass.pending).toEqual([B])
    expect(pass.planned).toEqual([])
  })
})
