import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

import { MetricCard, type MetricCardProps } from '../../src/metric-card/index.tsx'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:22Z'

function renderCard(props: MetricCardProps) {
  const user = userEvent.setup()
  const view = render(
    <TooltipProvider delayDuration={0}>
      <MetricCard {...props} />
    </TooltipProvider>,
  )
  return { user, ...view }
}

describe('MetricCard', () => {
  it('is a group named by its label', () => {
    renderCard({ state: 'ready', label: 'Open plans', value: 4 })

    const group = screen.getByRole('group', { name: 'Open plans' })
    expect(within(group).getByText('4')).toBeInTheDocument()
    expect(group).toHaveAttribute('data-state', 'ready')
    expect(group).not.toHaveAttribute('aria-busy')
  })

  it('shows a placeholder and a spoken "Loading" while loading, never a number', () => {
    renderCard({ state: 'loading', label: 'Open plans' })

    const group = screen.getByRole('group', { name: 'Open plans' })
    expect(group).toHaveAttribute('aria-busy', 'true')
    expect(within(group).getByText('Loading')).toBeInTheDocument()
    expect(group.textContent).not.toMatch(/\d/)
  })

  it('shows the failure and its code instead of a number when the read failed', () => {
    renderCard({
      state: 'failed',
      label: 'Open plans',
      failure: { code: 'STORE_UNAVAILABLE', message: 'The Control Store did not answer.' },
    })

    const group = screen.getByRole('group', { name: 'Open plans' })
    expect(group).toHaveTextContent('Could not read this metric: The Control Store did not answer.')
    expect(group).toHaveTextContent('STORE_UNAVAILABLE')
    expect(group).toHaveTextContent('This does not mean the value is zero.')
    expect(group.textContent).not.toMatch(/\b0\b/)
    expect(group.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })

  it('never shows a value in the failed state, even if one is passed by mistake', () => {
    const props = {
      state: 'failed',
      label: 'Open plans',
      failure: { code: 'UNKNOWN', message: 'Something failed.' },
      value: 4,
    } as unknown as MetricCardProps
    renderCard(props)

    expect(screen.getByRole('group').textContent).not.toContain('4')
  })

  it('marks a stale value as stale and shows how old it is', async () => {
    const { user } = renderCard({
      state: 'stale',
      label: 'Open plans',
      value: 4,
      observedAt: '2026-10-13T14:03:22Z',
      now: NOW,
    })

    const group = screen.getByRole('group', { name: 'Open plans' })
    expect(within(group).getByText('4')).toBeInTheDocument()
    expect(group).toHaveTextContent('Stale, read')
    expect(within(group).getByText('13 Oct 2026 14:03', { selector: 'time' })).toHaveAttribute(
      'datetime',
      '2026-10-13T14:03:22.000Z',
    )

    await user.tab()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('4 minutes ago')
  })

  it('says why a stale value could not be refreshed', () => {
    renderCard({
      state: 'stale',
      label: 'Open plans',
      value: 4,
      observedAt: '2026-10-13T14:03:22Z',
      now: NOW,
      failure: { code: 'TIMEOUT', message: 'The read timed out.' },
    })

    expect(screen.getByRole('group')).toHaveTextContent(
      'Refresh failed: The read timed out.TIMEOUT',
    )
  })

  it('shows the change with an arrow and says its direction in words', () => {
    renderCard({
      state: 'ready',
      label: 'Failed applies',
      value: 7,
      delta: { text: '+3', direction: 'up', tone: 'bad' },
    })

    const group = screen.getByRole('group')
    expect(group).toHaveTextContent('Up: +3')
    expect(group.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument()
  })

  it.each([
    ['down', 'Down: -2'],
    ['flat', 'Unchanged: 0'],
  ] as const)('speaks a %s change', (direction, spoken) => {
    renderCard({
      state: 'ready',
      label: 'Open plans',
      value: 7,
      delta: { text: direction === 'down' ? '-2' : '0', direction },
    })

    expect(screen.getByRole('group')).toHaveTextContent(spoken)
  })

  it('explains the metric in a tooltip, opened by keyboard focus', async () => {
    const { user } = renderCard({
      state: 'ready',
      label: 'Open plans',
      value: 4,
      help: 'Plans that are neither applied nor expired.',
    })

    await user.tab()

    expect(screen.getByRole('button', { name: 'About Open plans' })).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Plans that are neither applied nor expired.',
    )
  })

  it('links to the page that explains the number, through the link seam', () => {
    function RouterLink({ href, children, ...rest }: LinkComponentProps) {
      return (
        <a href={href} data-router="yes" {...rest}>
          {children}
        </a>
      )
    }
    render(
      <TooltipProvider>
        <LinkProvider component={RouterLink}>
          <MetricCard state="ready" label="Open plans" value={4} href="/changes/plans" />
        </LinkProvider>
      </TooltipProvider>,
    )

    const link = screen.getByRole('link', { name: 'View Open plans' })
    expect(link).toHaveAttribute('href', '/changes/plans')
    expect(link).toHaveAttribute('data-router', 'yes')
  })

  it('names the link as asked', () => {
    renderCard({
      state: 'ready',
      label: 'Open plans',
      value: 4,
      href: '/changes/plans',
      linkLabel: 'Open the plans page',
    })

    expect(screen.getByRole('link', { name: 'Open the plans page' })).toBeInTheDocument()
  })

  it('shows the label as text, never as markup', () => {
    renderCard({ state: 'ready', label: '<b>Plans</b>', value: 4 })

    expect(screen.getByText('<b>Plans</b>')).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })

  it('has no accessibility violations in any state', async () => {
    const states: MetricCardProps[] = [
      { state: 'loading', label: 'Open plans' },
      { state: 'ready', label: 'Open plans', value: 4, help: 'Help', href: '/changes/plans' },
      {
        state: 'stale',
        label: 'Open plans',
        value: 4,
        observedAt: '2026-10-13T14:03:22Z',
        now: NOW,
      },
      { state: 'failed', label: 'Open plans', failure: { code: 'UNKNOWN', message: 'Failed.' } },
    ]
    for (const props of states) {
      const { container, unmount } = renderCard(props)
      expect(await axeViolations(container)).toEqual([])
      unmount()
    }
  })
})
