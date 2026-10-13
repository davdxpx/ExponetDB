import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Database } from '../src/index.ts'

describe('icons', () => {
  it('renders a Lucide icon as an SVG that screen readers skip', () => {
    const { container } = render(<Database />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})
