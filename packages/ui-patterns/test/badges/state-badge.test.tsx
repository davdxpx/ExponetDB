import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { type HealthState, StateBadge } from '../../src/badges/state-badge.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'
const FOUR_MINUTES_AGO = '2026-10-13T14:03:30Z'

function withProvider(node: React.ReactNode) {
  return <TooltipProvider delayDuration={0}>{node}</TooltipProvider>
}

const STATES: readonly [HealthState, string][] = [
  ['healthy', 'Healthy'],
  ['degraded', 'Degraded'],
  ['unhealthy', 'Unhealthy'],
  ['unknown', 'Unknown'],
  ['stale', 'Stale'],
]

describe('StateBadge', () => {
  it.each(STATES)('shows %s as a word and an icon', (state, label) => {
    render(withProvider(<StateBadge state={state} />))

    const badge = screen.getByText(label)
    expect(badge).toHaveAttribute('data-health', state)
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('uses a different icon shape for healthy, degraded and unhealthy, so color is not the only signal', () => {
    const { container } = render(
      withProvider(
        <>
          <StateBadge state="healthy" />
          <StateBadge state="degraded" />
          <StateBadge state="unhealthy" />
        </>,
      ),
    )

    const shapes = [...container.querySelectorAll('svg[data-status]')].map((svg) =>
      svg.getAttribute('data-status'),
    )
    expect(new Set(shapes).size).toBe(3)
  })

  it('has no tooltip and is not focusable without a source or a time', async () => {
    const user = userEvent.setup()
    render(withProvider(<StateBadge state="healthy" />))

    await user.tab()

    expect(screen.getByText('Healthy').parentElement).not.toHaveFocus()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows source and age on keyboard focus', async () => {
    const user = userEvent.setup()
    render(
      withProvider(
        <StateBadge state="healthy" source="live" observedAt={FOUR_MINUTES_AGO} now={NOW} />,
      ),
    )

    await user.tab()

    expect(await screen.findByRole('tooltip')).toHaveTextContent('live, 4 min ago')
  })

  it('shows source and age on hover', async () => {
    const user = userEvent.setup()
    render(
      withProvider(
        <StateBadge state="stale" source="cached" observedAt="2026-10-13T12:07:30Z" now={NOW} />,
      ),
    )

    await user.hover(screen.getByText('Stale'))

    expect(await screen.findByRole('tooltip')).toHaveTextContent('cached, 2 h ago')
  })

  it('names the source alone, or the age alone', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      withProvider(<StateBadge state="healthy" source="agent_reported" />),
    )
    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('reported by agent')

    rerender(withProvider(<StateBadge state="healthy" observedAt={FOUR_MINUTES_AGO} now={NOW} />))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('4 min ago')
  })

  it('says the time is unknown when it is not a date', async () => {
    const user = userEvent.setup()
    render(
      withProvider(<StateBadge state="healthy" source="live" observedAt="garbage" now={NOW} />),
    )

    await user.tab()

    expect(await screen.findByRole('tooltip')).toHaveTextContent('live, time unknown')
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      withProvider(
        <>
          <StateBadge state="healthy" source="live" observedAt={FOUR_MINUTES_AGO} now={NOW} />
          <StateBadge state="unknown" />
        </>,
      ),
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
