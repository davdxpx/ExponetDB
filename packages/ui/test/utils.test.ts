import { describe, expect, it } from 'vitest'

import { type ClassValue, cn } from '../src/lib/utils.ts'

describe('cn', () => {
  it('joins truthy class names and lets the last conflicting utility win', () => {
    expect(cn('p-2', false, undefined, 'text-sm', 'p-4')).toBe('text-sm p-4')
  })

  it('joins conditional inputs like clsx', () => {
    const input: ClassValue[] = ['a', ['b', { c: true, d: false }], undefined, null, false && 'e']
    expect(cn(...input)).toBe('a b c')
  })

  it('resolves conflicting Tailwind utilities, last one wins', () => {
    expect(cn('p-2 text-foreground', 'p-4', 'text-foreground-light')).toBe(
      'p-4 text-foreground-light',
    )
    expect(cn('h-full', 'h-96')).toBe('h-96')
  })

  it('treats the card and content spacing steps of the tokens as spacing utilities', () => {
    expect(cn('p-4', 'p-card')).toBe('p-card')
    expect(cn('px-content', 'px-6')).toBe('px-6')
    expect(cn('gap-2', 'gap-card')).toBe('gap-card')
    expect(cn('py-content', 'p-4')).toBe('p-4')
  })

  it('treats the item and panel radii and the enter and move easings as theme steps', () => {
    expect(cn('rounded-md', 'rounded-item')).toBe('rounded-item')
    expect(cn('rounded-panel', 'rounded-lg')).toBe('rounded-lg')
    expect(cn('ease-in', 'ease-move')).toBe('ease-move')
    expect(cn('ease-move', 'ease-enter')).toBe('ease-enter')
  })

  it('keeps variants separate from base utilities', () => {
    expect(cn('p-2 hover:p-4', 'md:p-6')).toBe('p-2 hover:p-4 md:p-6')
  })

  it('never drops the custom utilities of the token package', () => {
    const custom = 'focus-ring control-surface-shadows raised-control-surface hit-area-1'
    expect(cn(custom, 'border-0 text-xs h-[26px]', 'px-4 text-sm')).toBe(
      `${custom} border-0 h-[26px] px-4 text-sm`,
    )
    expect(cn('focus-ring', 'focus-visible:ring-0')).toBe('focus-ring focus-visible:ring-0')
  })

  it('keeps a size and a custom color of the same prefix apart and merges colors with each other', () => {
    expect(cn('text-sm', 'text-foreground-light')).toBe('text-sm text-foreground-light')
    expect(cn('text-foreground-light', 'text-foreground-lighter')).toBe('text-foreground-lighter')
    expect(cn('bg-surface-100', 'bg-surface-200')).toBe('bg-surface-200')
    expect(cn('border border-strong', 'border-control')).toBe('border border-control')
  })

  it('keeps an important utility beside a plain one', () => {
    expect(cn('text-foreground-light', 'text-destructive!')).toBe(
      'text-foreground-light text-destructive!',
    )
    expect(cn('bg-primary-bright/70!', 'bg-accent')).toBe('bg-primary-bright/70! bg-accent')
  })

  it('keeps a gradient background image beside a background color', () => {
    const gradient =
      'bg-[linear-gradient(to_bottom,hsl(var(--colors-white)/0.015),hsl(var(--colors-black)/0.01))]'
    expect(cn('bg-primary-solid', gradient)).toBe(`bg-primary-solid ${gradient}`)
  })
})
