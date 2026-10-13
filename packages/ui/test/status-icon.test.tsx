import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { StatusIcon, type StatusVariant } from '../src/status-icon.tsx'
import { SuccessCheck } from '../src/success-check.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const VARIANTS: readonly (readonly [StatusVariant, string])[] = [
  ['default', 'Information'],
  ['info', 'Information'],
  ['success', 'Success'],
  ['warning', 'Warning'],
  ['destructive', 'Error'],
]

describe('StatusIcon', () => {
  it.each(VARIANTS)('the %s variant is an image named "%s"', (variant, name) => {
    render(<StatusIcon variant={variant} />)

    const icon = screen.getByRole('img', { name })
    expect(icon.tagName.toLowerCase()).toBe('svg')
    expect(icon).toHaveAttribute('data-status', variant)
  })

  it('uses a different shape for success, warning, error and information', () => {
    const shape = (variant: StatusVariant) => {
      const { container, unmount } = render(<StatusIcon variant={variant} />)
      const d = container.querySelector('path')?.getAttribute('d')
      unmount()
      return d
    }
    const shapes = [shape('success'), shape('warning'), shape('destructive'), shape('info')]

    expect(new Set(shapes).size).toBe(4)
    // The default is the information glyph.
    expect(shape('default')).toBe(shape('info'))
  })

  it('takes a custom accessible name', () => {
    render(<StatusIcon variant="warning" label="Backup is overdue" />)

    expect(screen.getByRole('img', { name: 'Backup is overdue' })).toBeInTheDocument()
  })

  it('hides a decorative icon from assistive technology', () => {
    render(
      <>
        <StatusIcon variant="destructive" decorative />
        <span>Failed</span>
      </>,
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(document.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('can draw the bare glyph and forwards ref and class names', () => {
    const ref = createRef<SVGSVGElement>()
    render(<StatusIcon ref={ref} variant="success" hideBackground className="size-6" />)

    const icon = screen.getByRole('img', { name: 'Success' })
    expect(ref.current).toBe(icon)
    expect(icon).toHaveClass('text-success', 'size-6')
    expect(icon).not.toHaveClass('rounded-sm')
  })

  it('has no axe violations for any variant, named or decorative', async () => {
    render(
      <>
        {VARIANTS.map(([variant]) => (
          <StatusIcon key={variant} variant={variant} />
        ))}
        <StatusIcon variant="warning" decorative />
      </>,
    )

    expect(await axeViolations()).toEqual([])
  })
})

describe('SuccessCheck', () => {
  it('is an image named "Success"', () => {
    render(<SuccessCheck />)

    expect(screen.getByRole('img', { name: 'Success' })).toBeInTheDocument()
  })

  it('takes a custom name or hides itself when text says it already', () => {
    const { rerender } = render(<SuccessCheck label="Plan verified" />)
    expect(screen.getByRole('img', { name: 'Plan verified' })).toBeInTheDocument()

    rerender(
      <>
        <SuccessCheck decorative />
        <span>Done</span>
      </>,
    )
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    render(<SuccessCheck />)

    expect(await axeViolations()).toEqual([])
  })
})
