import { describe, expect, it } from 'vitest'
import { mismatches, satisfies } from '../checks/toolchain.ts'

/**
 * The pinned toolchain (test campaign TC-051): `engines` is advisory in Bun, so a run on Node 26 or
 * Bun 1.3 looked authoritative. The check compares the running versions with `engines`.
 */
describe('satisfies', () => {
  it.each([
    ['24.22.1', '>=24.22.1 <25', true],
    ['24.23.0', '>=24.22.1 <25', true],
    ['24.22.0', '>=24.22.1 <25', false],
    ['25.0.0', '>=24.22.1 <25', false],
    ['26.5.0', '>=24.22.1 <25', false],
    ['1.4.4', '>=1.4.4', true],
    ['1.3.14', '>=1.4.4', false],
    ['2.0.0', '>=1.4.4', true],
  ])('%s against %s is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected)
  })

  it('refuses a range or a version it cannot read, never accepts it', () => {
    expect(satisfies('24.22.1', 'latest')).toBe(false)
    expect(satisfies('v24', '>=24.22.1 <25')).toBe(false)
  })
})

describe('mismatches', () => {
  const engines = { node: '>=24.22.1 <25', bun: '>=1.4.4' }

  it('is empty on the pinned toolchain', () => {
    expect(mismatches(engines, { node: '24.22.1', bun: '1.4.4' })).toEqual([])
  })

  it('names each tool outside its range with the version it runs', () => {
    expect(mismatches(engines, { node: '26.5.0', bun: '1.3.14' })).toEqual([
      'node 26.5.0 is outside >=24.22.1 <25',
      'bun 1.3.14 is outside >=1.4.4',
    ])
  })

  it('names a tool that is not there', () => {
    expect(mismatches(engines, { node: '24.22.1', bun: undefined })).toEqual([
      'bun is not available (needs >=1.4.4)',
    ])
  })
})
