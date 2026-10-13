import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { InfoTooltip } from '../src/info-tooltip.tsx'
import { axeViolations } from './support/axe.ts'

afterEach(cleanup)

function renderTooltip(ui: React.ReactNode) {
  const user = userEvent.setup()
  const view = render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>)
  return { user, ...view }
}

describe('InfoTooltip', () => {
  it('is a button with an accessible name', () => {
    renderTooltip(<InfoTooltip>Plans expire after 24 hours.</InfoTooltip>)

    expect(screen.getByRole('button', { name: 'More information' })).toBeInTheDocument()
  })

  it('takes a name that says what it explains', () => {
    renderTooltip(<InfoTooltip label="About plan expiry">Plans expire after 24 hours.</InfoTooltip>)

    expect(screen.getByRole('button', { name: 'About plan expiry' })).toBeInTheDocument()
  })

  it('opens on keyboard focus, describes the button and closes with Escape', async () => {
    const { user } = renderTooltip(<InfoTooltip>Plans expire after 24 hours.</InfoTooltip>)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    await user.tab()

    const button = screen.getByRole('button')
    expect(button).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Plans expire after 24 hours.')
    expect(button).toHaveAccessibleDescription('Plans expire after 24 hours.')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  })

  it('opens on pointer hover', async () => {
    const { user } = renderTooltip(<InfoTooltip>Plans expire after 24 hours.</InfoTooltip>)

    await user.hover(screen.getByRole('button'))

    expect(await screen.findByRole('tooltip')).toBeInTheDocument()
  })

  it('hides the glyph from assistive technology and renders the text as text', async () => {
    const { container, user } = renderTooltip(<InfoTooltip>{'<b>bold</b>'}</InfoTooltip>)

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    await user.tab()
    expect((await screen.findByRole('tooltip')).textContent).toContain('<b>bold</b>')
    expect(document.querySelector('b')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = renderTooltip(<InfoTooltip>Plans expire after 24 hours.</InfoTooltip>)

    expect(await axeViolations(container)).toEqual([])
  })
})
