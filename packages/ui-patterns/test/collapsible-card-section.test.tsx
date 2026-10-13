import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { CollapsibleCardSection } from '../src/collapsible-card-section.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

describe('CollapsibleCardSection', () => {
  it('is closed by default: a button with aria-expanded=false and no content in the tree', () => {
    render(
      <CollapsibleCardSection title="Advanced settings">
        <p>Lock timeout</p>
      </CollapsibleCardSection>,
    )

    const trigger = screen.getByRole('button', { name: 'Advanced settings' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Lock timeout')).not.toBeInTheDocument()
  })

  it('opens and closes with the keyboard', async () => {
    const user = userEvent.setup()
    render(
      <CollapsibleCardSection title="Advanced settings" description="Rarely needed.">
        <p>Lock timeout</p>
      </CollapsibleCardSection>,
    )

    await user.tab()
    await user.keyboard('{Enter}')

    const trigger = screen.getByRole('button', { name: 'Advanced settings' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Lock timeout')).toBeVisible()
    expect(screen.getByText('Rarely needed.')).toBeVisible()
    expect(trigger).toHaveAttribute(
      'aria-controls',
      screen.getByText('Lock timeout').parentElement?.id,
    )

    await user.keyboard(' ')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('can start open', () => {
    render(
      <CollapsibleCardSection title="Advanced settings" defaultOpen>
        <p>Lock timeout</p>
      </CollapsibleCardSection>,
    )

    expect(screen.getByRole('button', { name: 'Advanced settings' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('Lock timeout')).toBeVisible()
  })

  it('hides the chevron from assistive technology', () => {
    const { container } = render(
      <CollapsibleCardSection title="Advanced settings">
        <p>Lock timeout</p>
      </CollapsibleCardSection>,
    )

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <CollapsibleCardSection title="Advanced settings" defaultOpen description="Rarely needed.">
        <p>Lock timeout</p>
      </CollapsibleCardSection>,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
