// Derived from supabase/supabase packages/ui-patterns/src/Row/index.test.ts @ 8b9af568. Apache-2.0 (Copyright 2024 Supabase); package declared MIT. Modified for ExponetDB.
import { describe, expect, it } from 'vitest'

import { resolveColumnsForWidth } from '../../src/row/index.tsx'

describe('resolveColumnsForWidth', () => {
  it('caps the visible count by maxColumns', () => {
    expect(resolveColumnsForWidth({ width: 1600, maxColumns: 4, minWidth: 280, gap: 16 })).toBe(4)
  })

  it('reduces visible items as the container narrows', () => {
    expect(resolveColumnsForWidth({ width: 1200, maxColumns: 4, minWidth: 280, gap: 16 })).toBe(4)
    expect(resolveColumnsForWidth({ width: 900, maxColumns: 4, minWidth: 280, gap: 16 })).toBe(3)
    expect(resolveColumnsForWidth({ width: 700, maxColumns: 4, minWidth: 280, gap: 16 })).toBe(2)
    expect(resolveColumnsForWidth({ width: 500, maxColumns: 4, minWidth: 280, gap: 16 })).toBe(1)
  })

  it('always returns at least one visible slot', () => {
    expect(resolveColumnsForWidth({ width: 0, maxColumns: 4, minWidth: 280, gap: 16 })).toBe(1)
  })

  it('returns a safe value when minWidth and gap are both zero', () => {
    expect(resolveColumnsForWidth({ width: 1600, maxColumns: 4, minWidth: 0, gap: 0 })).toBe(4)
  })
})
