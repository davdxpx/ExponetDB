import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'

import { Badge } from '../src/badge.tsx'
import { axeViolations } from './support/axe.ts'

const VARIANTS = {
  default: 'border-strong',
  warning: 'text-warning-600',
  success: 'text-success-600',
  destructive: 'text-destructive',
  secondary: 'text-secondary-foreground',
} as const

describe('Badge', () => {
  for (const [variant, marker] of Object.entries(VARIANTS)) {
    it(`renders the ${variant} variant with its text`, async () => {
      render(<Badge variant={variant as keyof typeof VARIANTS}>Verified</Badge>)

      const badge = screen.getByText('Verified')
      expect(badge).toHaveClass('rounded-full', marker)
      expect(await axeViolations()).toEqual([])
    })
  }

  it('uses the default variant', () => {
    render(<Badge>Draft</Badge>)

    expect(screen.getByText('Draft')).toHaveClass('border-strong', 'bg-surface-75')
  })

  it('merges a className and passes other attributes through', () => {
    render(
      <Badge className="px-4" data-testid="badge" title="Applied">
        Applied
      </Badge>,
    )

    const badge = screen.getByTestId('badge')
    expect(badge).toHaveClass('px-4')
    expect(badge).not.toHaveClass('px-[5.5px]')
    expect(badge).toHaveAttribute('title', 'Applied')
  })

  it('forwards its ref so a tooltip can anchor to it', () => {
    const ref = createRef<HTMLDivElement>()
    render(<Badge ref={ref}>Stale</Badge>)

    expect(ref.current).toBe(screen.getByText('Stale'))
  })
})
