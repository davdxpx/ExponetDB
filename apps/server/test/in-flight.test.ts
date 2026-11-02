import { describe, expect, it } from 'vitest'
import { InFlight } from '../src/interfaces/http/in-flight.ts'

describe('the in-flight bound of large requests (VC-046, VC-078)', () => {
  it('admits up to its bound, refuses past it and takes a slot back on release, once', () => {
    const bound = new InFlight(2)
    const a = bound.enter()
    const b = bound.enter()
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(bound.enter()).toBeUndefined()
    a?.()
    a?.() // a second release does not free a second slot
    expect(bound.running).toBe(1)
    const c = bound.enter()
    expect(c).toBeDefined()
    expect(bound.enter()).toBeUndefined()
    b?.()
    c?.()
    expect(bound.running).toBe(0)
  })
})
