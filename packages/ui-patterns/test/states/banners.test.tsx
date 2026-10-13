import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PartialBanner } from '../../src/states/partial-banner.tsx'
import { StaleBanner } from '../../src/states/stale-banner.tsx'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'

describe('StaleBanner', () => {
  it('shows the source, the age and the exact time', () => {
    render(
      <StaleBanner what="schema" source="sampled" observedAt="2026-10-13T11:07:30Z" now={NOW} />,
    )

    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('Showing an earlier read of schema')
    expect(banner).toHaveTextContent('Source: sampled.')
    expect(banner).toHaveTextContent('3 h ago (2026-10-13 11:07 UTC)')
  })

  it('says the time is unknown when it is not a date', () => {
    render(<StaleBanner what="schema" source="cached" observedAt="garbage" now={NOW} />)

    expect(screen.getByRole('status')).toHaveTextContent('time unknown')
  })

  it('refreshes on request and shows it is busy', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const { rerender } = render(
      <StaleBanner
        what="schema"
        source="cached"
        observedAt={NOW}
        onRefresh={onRefresh}
        now={NOW}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledOnce()

    rerender(
      <StaleBanner
        what="schema"
        source="cached"
        observedAt={NOW}
        onRefresh={onRefresh}
        refreshing
        now={NOW}
      />,
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <StaleBanner
        what="schema"
        source="cached"
        observedAt={NOW}
        error={{ code: 'NETWORK', message: 'No answer.' }}
        onRefresh={() => {}}
        now={NOW}
      />,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})

describe('PartialBanner', () => {
  it('lists what is missing, one entry each, even when two are alike', () => {
    render(
      <PartialBanner
        what="inventory"
        source="live"
        observedAt={NOW}
        missing={['Node did not answer.', 'Node did not answer.', 'No access to staging.']}
        now={NOW}
      />,
    )

    const items = within(screen.getByRole('status')).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'Node did not answer.',
      'Node did not answer.',
      'No access to staging.',
    ])
  })

  it('says so when the read did not say what is missing', () => {
    render(<PartialBanner what="inventory" source="live" observedAt={NOW} missing={[]} now={NOW} />)

    expect(screen.getByRole('status')).toHaveTextContent('What is missing was not reported.')
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('shows what is missing as text', () => {
    const { container } = render(
      <PartialBanner
        what="inventory"
        source="live"
        observedAt={NOW}
        missing={['<img src=x onerror=alert(1)>']}
        now={NOW}
      />,
    )

    expect(container.querySelector('img')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    const { container } = render(
      <PartialBanner
        what="inventory"
        source="live"
        observedAt={NOW}
        missing={['a', 'b']}
        now={NOW}
      />,
    )

    expect(await axeViolations(container)).toEqual([])
  })
})
