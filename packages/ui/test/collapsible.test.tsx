import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../src/collapsible.tsx'
import { axeViolations } from './support/axe.ts'

describe('Collapsible', () => {
  it('toggles its content from the trigger with the keyboard and states it in aria-expanded', async () => {
    const user = userEvent.setup()
    render(
      <Collapsible>
        <CollapsibleTrigger>Advanced options</CollapsibleTrigger>
        <CollapsibleContent>Lock timeout</CollapsibleContent>
      </Collapsible>,
    )

    const trigger = screen.getByRole('button', { name: 'Advanced options' })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveClass('focus-inset')
    expect(screen.queryByText('Lock timeout')).not.toBeInTheDocument()
    expect(await axeViolations()).toEqual([])

    await user.tab()
    expect(trigger).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Lock timeout')).toBeVisible()
    expect(await axeViolations()).toEqual([])

    await user.keyboard(' ')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('removes a disabled trigger from the tab order', async () => {
    const user = userEvent.setup()
    render(
      <Collapsible>
        <CollapsibleTrigger disabled>Advanced options</CollapsibleTrigger>
        <CollapsibleContent>Lock timeout</CollapsibleContent>
      </Collapsible>,
    )

    const trigger = screen.getByRole('button', { name: 'Advanced options' })
    expect(trigger).toBeDisabled()
    await user.tab()
    expect(trigger).not.toHaveFocus()
  })

  it('lets a caller choose the tab index', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger tabIndex={-1}>Advanced options</CollapsibleTrigger>
      </Collapsible>,
    )

    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '-1')
  })
})
