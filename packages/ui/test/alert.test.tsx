import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Alert, AlertDescription, AlertTitle } from '../src/alert.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

const VARIANTS = [
  ['default', 'Information', 'status'],
  ['info', 'Information', 'status'],
  ['success', 'Success', 'status'],
  ['warning', 'Warning', 'status'],
  ['destructive', 'Error', 'alert'],
] as const

describe('Alert', () => {
  it.each(VARIANTS)(
    'the %s variant carries its meaning in an icon with the name "%s", not in color alone (role %s)',
    (variant, iconName, role) => {
      render(
        <Alert variant={variant}>
          <AlertTitle>Plan expired</AlertTitle>
          <AlertDescription>Create a new plan before you apply.</AlertDescription>
        </Alert>,
      )

      const alert = screen.getByRole(role)
      expect(alert).toHaveAttribute('data-slot', 'alert')
      expect(alert).toHaveTextContent('Plan expired')
      expect(alert).toHaveTextContent('Create a new plan before you apply.')
      expect(screen.getByRole('img', { name: iconName })).toBeInTheDocument()
    },
  )

  it('uses a different icon shape for each kind of message', () => {
    const paths = VARIANTS.filter(([variant]) => variant !== 'default').map(([variant]) => {
      const { container, unmount } = render(
        <Alert variant={variant}>
          <AlertTitle>Message</AlertTitle>
        </Alert>,
      )
      const path = container.querySelector('svg path')?.getAttribute('d')
      unmount()
      return path
    })

    expect(new Set(paths).size).toBe(paths.length)
  })

  it('defaults to the default variant', () => {
    render(<Alert>Plain note</Alert>)

    expect(screen.getByRole('status')).toHaveTextContent('Plain note')
  })

  it('can leave the icon out or replace it', () => {
    const { rerender } = render(<Alert icon={false}>No icon</Alert>)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()

    rerender(<Alert icon={<svg role="img" aria-label="Custom marker" />}>Own icon</Alert>)
    expect(screen.getByRole('img', { name: 'Custom marker' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Information' })).not.toBeInTheDocument()
  })

  it('lets the caller override the live-region role', () => {
    render(
      <Alert variant="destructive" role="status">
        Quiet failure
      </Alert>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Quiet failure')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('wraps a text description in a paragraph', () => {
    render(
      <Alert>
        <AlertDescription>Just text</AlertDescription>
      </Alert>,
    )

    expect(screen.getByText('Just text').tagName).toBe('P')
  })

  it('has no axe violations in any variant', async () => {
    render(
      <div>
        {VARIANTS.map(([variant]) => (
          <Alert key={variant} variant={variant}>
            <AlertTitle>{variant} title</AlertTitle>
            <AlertDescription>{variant} description</AlertDescription>
          </Alert>
        ))}
      </div>,
    )

    expect(await axeViolations()).toEqual([])
  })
})
