import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChartEmptyState,
  ChartFailedState,
  ChartLoadingState,
  ChartUnavailableState,
  ReadableChart,
} from '../../src/charts/chart-states.tsx'
import type { Readable, ReadFailure } from '../../src/readable.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = Date.parse('2026-10-13T10:00:00Z')
const failure: ReadFailure = { code: 'NODE_UNREACHABLE', message: 'The node agent did not answer.' }

function renderChart(
  readable: Readable<readonly number[]>,
  extra: Partial<Parameters<typeof ReadableChart<readonly number[]>>[0]> = {},
) {
  const body = vi.fn((values: readonly number[]) => <p>Chart with {values.length} values</p>)
  const view = render(
    <ReadableChart
      name="query latency"
      readable={readable}
      isEmpty={(values) => values.length === 0}
      now={NOW}
      {...extra}
    >
      {body}
    </ReadableChart>,
  )
  return { ...view, body }
}

describe('loading', () => {
  it('announces one status and draws a skeleton of the chart height, not the chart', () => {
    const { body, container } = renderChart({ state: 'loading' }, { height: 180 })
    expect(screen.getByRole('status')).toHaveTextContent('Loading query latency')
    expect(body).not.toHaveBeenCalled()
    expect(container.querySelector('[data-state="loading"] > div')).toHaveStyle({ height: '180px' })
    expect(screen.queryByText('No data in this period')).toBeNull()
  })
})

describe('failed read', () => {
  const failed: Readable<readonly number[]> = { state: 'failed', error: failure }

  it('says it could not read, that this is not an empty result, and shows the code', () => {
    const { body } = renderChart(failed)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(
      'Could not read query latency: The node agent did not answer. This does not mean there is no data.',
    )
    expect(alert).toHaveTextContent('Error code: NODE_UNREACHABLE')
    expect(body).not.toHaveBeenCalled()
  })

  it('never renders the empty state, even though an empty value would qualify', () => {
    renderChart(failed, { isEmpty: () => true })
    expect(screen.queryByText('No data in this period')).toBeNull()
    expect(document.querySelector('[data-state="empty"]')).toBeNull()
  })

  it('offers a retry only when the caller can retry', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    const first = renderChart(failed)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    first.unmount()

    renderChart(failed, { onRetry })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows hostile text in a name as text with hidden characters made visible', () => {
    render(<ChartFailedState name={'<b>latency</b>‮'} error={failure} />)
    expect(screen.getByRole('alert').querySelector('b')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('<b>latency</b>⟨U+202E⟩')
  })
})

describe('ready', () => {
  it('draws the chart and names the source and the age of the read', () => {
    const { body } = renderChart({
      state: 'ready',
      value: [1, 2, 3],
      source: 'sampled',
      observedAt: '2026-10-13T09:56:00Z',
    })
    expect(body).toHaveBeenCalledWith([1, 2, 3])
    expect(screen.getByText('Chart with 3 values')).toBeInTheDocument()
    const note = document.querySelector('[data-slot="source-note"]')
    expect(note).toHaveTextContent('Sampled, observed 4 minutes ago (Oct 13, 09:56 UTC)')
    expect(note?.querySelector('time')).toHaveAttribute('dateTime', '2026-10-13T09:56:00Z')
  })

  it('shows the empty state only after a read that succeeded and found nothing', () => {
    const { body } = renderChart(
      { state: 'ready', value: [], source: 'live', observedAt: '2026-10-13T10:00:00Z' },
      { emptyTitle: 'No samples yet', emptyDescription: 'The agent has not reported.' },
    )
    expect(body).not.toHaveBeenCalled()
    expect(screen.getByText('No samples yet')).toBeInTheDocument()
    expect(screen.getByText('The agent has not reported.')).toBeInTheDocument()
    expect(document.querySelector('[data-state="empty"]')).not.toBeNull()
  })

  it('says when the time of an observation is not known', () => {
    renderChart({ state: 'ready', value: [1], source: 'inferred', observedAt: 'not a time' })
    expect(document.querySelector('[data-slot="source-note"]')).toHaveTextContent(
      'Inferred from other observations, observation time not known',
    )
  })
})

describe('stale', () => {
  const stale: Readable<readonly number[]> = {
    state: 'stale',
    value: [4, 5],
    source: 'cached',
    observedAt: '2026-10-13T09:48:00Z',
    error: failure,
  }

  it('keeps the chart, shows its age and why the refresh failed', () => {
    const { body } = renderChart(stale)
    expect(body).toHaveBeenCalledWith([4, 5])
    const note = document.querySelector('[data-slot="stale-note"]')
    expect(note).toHaveTextContent('Stale data')
    expect(note).toHaveTextContent('Cached, observed 12 minutes ago (Oct 13, 09:48 UTC)')
    expect(note).toHaveTextContent('Refreshing failed: The node agent did not answer')
    expect(note).toHaveTextContent('Error code: NODE_UNREACHABLE')
  })

  it('offers a refresh only when the caller can refresh', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    const first = renderChart(stale)
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
    first.unmount()

    renderChart(stale, { onRefresh })
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('still names an empty cached read as stale', () => {
    renderChart({ ...stale, value: [] })
    expect(document.querySelector('[data-slot="stale-note"]')).not.toBeNull()
    expect(document.querySelector('[data-state="empty"]')).not.toBeNull()
  })
})

describe('partial', () => {
  it('lists what is missing next to the data', () => {
    const { body } = renderChart({
      state: 'partial',
      value: [1, 2],
      source: 'agent_reported',
      observedAt: '2026-10-13T09:59:00Z',
      missing: ['replica-2: the node agent is offline', 'replica-3: no read permission'],
    })
    expect(body).toHaveBeenCalledWith([1, 2])
    const note = document.querySelector('[data-slot="partial-note"]')
    expect(note).toHaveTextContent('Partial data')
    const items = within(note as HTMLElement).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      'replica-2: the node agent is offline',
      'replica-3: no read permission',
    ])
  })

  it('does not claim "no data" for an empty partial read', () => {
    renderChart({
      state: 'partial',
      value: [],
      source: 'sampled',
      observedAt: '2026-10-13T09:59:00Z',
      missing: ['replica-2: the node agent is offline'],
    })
    expect(document.querySelector('[data-slot="partial-note"]')).not.toBeNull()
  })
})

describe('other states', () => {
  it('shows an empty state with a default title', () => {
    render(<ChartEmptyState />)
    expect(screen.getByText('No data in this period')).toBeInTheDocument()
  })

  it('shows a chart that is not supported or not permitted, with no placeholder data', () => {
    render(
      <ChartUnavailableState
        kind="not_permitted"
        title="You cannot see this chart"
        description="It needs the metrics:read permission on this target."
      >
        <a href="/access">Request access</a>
      </ChartUnavailableState>,
    )
    expect(screen.getByText('You cannot see this chart')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request access' })).toHaveAttribute('href', '/access')
    expect(document.querySelector('svg.recharts-surface')).toBeNull()
  })

  it('has no accessibility violations in any state', async () => {
    const { container } = render(
      <div>
        <ChartLoadingState name="query latency" />
        <ChartFailedState name="query latency" error={failure} onRetry={() => {}} />
        <ChartEmptyState />
        <ChartUnavailableState
          kind="not_supported"
          title="Not supported"
          description="Needs PostgreSQL 17."
        />
      </div>,
    )
    expect(await axeViolations(container)).toEqual([])
  })
})
