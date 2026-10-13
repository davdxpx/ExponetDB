import { describe, expect, it } from 'vitest'
import { cn } from '../src/index.ts'

describe('cn', () => {
  it('joins truthy class names and lets the last conflicting utility win', () => {
    expect(cn('p-2', false, undefined, 'text-sm', 'p-4')).toBe('text-sm p-4')
  })
})
