import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Separator } from '../src/separator.tsx'
import { axeViolations } from './support/axe.ts'

describe('Separator', () => {
  it('is decorative by default: hidden from assistive technology', async () => {
    const { container } = render(<Separator />)

    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    const element = container.firstElementChild
    expect(element).toHaveAttribute('role', 'none')
    expect(element).toHaveAttribute('data-orientation', 'horizontal')
    expect(element).toHaveClass('h-px', 'w-full')
    expect(await axeViolations()).toEqual([])
  })

  it('is a separator with an orientation when it is not decorative', async () => {
    render(<Separator decorative={false} orientation="vertical" />)

    const separator = screen.getByRole('separator')
    expect(separator).toHaveAttribute('aria-orientation', 'vertical')
    expect(separator).toHaveClass('h-full', 'w-px')
    expect(await axeViolations()).toEqual([])
  })

  it('merges a className', () => {
    const { container } = render(<Separator className="my-4 bg-border" />)

    expect(container.firstElementChild).toHaveClass('my-4', 'bg-border')
    expect(container.firstElementChild).not.toHaveClass('bg-border-muted')
  })
})
