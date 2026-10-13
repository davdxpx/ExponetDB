import '@testing-library/jest-dom/vitest'
import { Database } from '@exponetdb/icons'
import { Button } from '@exponetdb/ui'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { EmptyState } from '../../src/empty-state/index.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

describe('EmptyState', () => {
  it('renders the title as a heading, the description and the action', () => {
    render(
      <EmptyState title="No backups yet" description="Backups appear after the first run.">
        <Button>Create backup policy</Button>
      </EmptyState>,
    )

    expect(screen.getByRole('heading', { level: 3, name: 'No backups yet' })).toBeInTheDocument()
    expect(screen.getByText('Backups appear after the first run.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create backup policy' })).toBeInTheDocument()
  })

  it('uses the heading level it is given', () => {
    render(<EmptyState title="Nothing" headingLevel={2} />)

    expect(screen.getByRole('heading', { level: 2, name: 'Nothing' })).toBeInTheDocument()
  })

  it('renders an icon component type and an element, both hidden from assistive technology', () => {
    const { container, rerender } = render(<EmptyState title="Nothing" icon={Database} />)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('[aria-hidden="true"] svg')).not.toBeNull()

    rerender(<EmptyState title="Nothing" icon={<svg data-testid="own-icon" />} />)
    expect(container.querySelector('[aria-hidden="true"] [data-testid="own-icon"]')).not.toBeNull()
  })

  it('renders no icon by default', () => {
    const { container } = render(<EmptyState title="Nothing" />)

    expect(container.querySelector('svg')).toBeNull()
  })

  it('is not an alert: it does not claim anything went wrong', () => {
    render(<EmptyState title="Nothing" />)

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <EmptyState icon={Database} title="No backups yet" description="Check again later.">
        <Button>Create backup policy</Button>
      </EmptyState>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
