import { describe, expect, it } from 'vitest'

import { versionRelation } from '../../src/infrastructure/version-skew.ts'

describe('versionRelation', () => {
  it('knows equal versions', () => {
    expect(versionRelation('1.2.3', '1.2.3')).toBe('same')
    expect(versionRelation('dev-build', 'dev-build')).toBe('same')
  })

  it('compares major, minor and patch as numbers', () => {
    expect(versionRelation('1.2.3', '1.2.4')).toBe('older')
    expect(versionRelation('1.2.3', '1.3.0')).toBe('older')
    expect(versionRelation('1.2.3', '2.0.0')).toBe('older')
    expect(versionRelation('1.10.0', '1.9.0')).toBe('newer')
    expect(versionRelation('1.2.4', '1.2.3')).toBe('newer')
  })

  it('accepts a leading v and a suffix', () => {
    expect(versionRelation('v1.2.3', '1.2.4')).toBe('older')
    expect(versionRelation('1.2.3-rc.1', '1.2.3')).toBe('different')
  })

  it('reports text it cannot compare as different and never guesses an order', () => {
    expect(versionRelation('nightly', '1.2.3')).toBe('different')
    expect(versionRelation('1.2.3', 'nightly')).toBe('different')
    expect(versionRelation('', '1.2.3')).toBe('different')
  })
})
