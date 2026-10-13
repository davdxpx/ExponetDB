import { describe, expect, it } from 'vitest'

import {
  PAGE_SIZE_CLASSES,
  SIZE,
  SIZE_VARIANTS,
  SIZE_VARIANTS_DEFAULT,
  SIZE_VARIANTS_INNER,
} from '../src/lib/constants.ts'
import { controlRadiusBySize } from '../src/lib/raised-control-surface.ts'

describe('control sizes', () => {
  it('give Button, Input and the select triggers one scale of four sizes', () => {
    expect(Object.keys(SIZE_VARIANTS)).toEqual(['tiny', 'small', 'medium', 'large'])
    expect(Object.keys(SIZE_VARIANTS_INNER)).toEqual(['tiny', 'small', 'medium', 'large'])
  })

  it('compose text size, padding and height from the same tables', () => {
    expect(SIZE_VARIANTS.tiny).toBe(`${SIZE.text.tiny} ${SIZE.padding.tiny} ${SIZE.height.tiny}`)
    expect(SIZE_VARIANTS.large).toBe(
      `${SIZE.text.large} ${SIZE.padding.large} ${SIZE.height.large}`,
    )
  })

  it('grow in height from tiny to large, and the inner variants stay below the outer ones', () => {
    const height = (value: string) => Number(/h-\[(\d+)px\]/.exec(value)?.[1])
    const heights = Object.values(SIZE_VARIANTS).map(height)
    const inner = Object.values(SIZE_VARIANTS_INNER).map(height)
    expect(heights).toEqual([26, 34, 38, 42])
    expect([...heights].sort((a, b) => a - b)).toEqual(heights)
    for (const [index, value] of inner.entries()) {
      expect(value).toBeLessThan(heights[index] ?? 0)
    }
  })

  it('default to the small size', () => {
    expect(SIZE_VARIANTS_DEFAULT).toBe('small')
  })

  it('give every size a radius that grows with the height', () => {
    expect(controlRadiusBySize.tiny).toBe('rounded-md')
    expect(controlRadiusBySize.small).toContain('34/26')
    expect(controlRadiusBySize.medium).toContain('38/26')
    expect(controlRadiusBySize.large).toContain('42/26')
  })

  it('have page widths for the page layouts', () => {
    expect(PAGE_SIZE_CLASSES.full).toBe('w-full')
    expect(PAGE_SIZE_CLASSES.default).toBe(PAGE_SIZE_CLASSES.medium)
  })
})
