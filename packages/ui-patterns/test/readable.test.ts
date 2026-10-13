import { describe, expect, it } from 'vitest'
import { type Readable, readableValue } from '../src/index.ts'

describe('Readable', () => {
  it('yields a value only for reads that produced one', () => {
    const at = '2026-10-13T12:00:00.000Z'
    const cases: [Readable<number[]>, number[] | undefined][] = [
      [{ state: 'loading' }, undefined],
      [{ state: 'failed', error: { code: 'NETWORK', message: 'x' } }, undefined],
      [{ state: 'ready', value: [], source: 'live', observedAt: at }, []],
      [{ state: 'stale', value: [1], source: 'cached', observedAt: at }, [1]],
      [{ state: 'partial', value: [2], source: 'live', observedAt: at, missing: ['m'] }, [2]],
    ]
    for (const [readable, value] of cases) {
      expect(readableValue(readable)).toEqual(value)
    }
  })
})
