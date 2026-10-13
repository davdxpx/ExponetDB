import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Chart,
  ChartActions,
  ChartCard,
  ChartContent,
  ChartFooter,
  ChartHeader,
  ChartMetric,
  ChartTitle,
  ChartValueDifferential,
} from '../../src/chart/index.tsx'
import { type LinkComponentProps, LinkProvider } from '../../src/seams/index.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = Date.parse('2026-10-13T10:00:00Z')

function withTooltips(node: React.ReactNode) {
  return <TooltipProvider>{node}</TooltipProvider>
}

describe('frame', () => {
  it('lays out a card with header, title, content and footer', () => {
    const ref = createRef<HTMLDivElement>()
    render(
      withTooltips(
        <ChartCard ref={ref} data-testid="card">
          <ChartHeader>
            <ChartTitle>Connections</ChartTitle>
          </ChartHeader>
          <ChartContent>
            <Chart>content</Chart>
          </ChartContent>
          <ChartFooter>footer</ChartFooter>
        </ChartCard>,
      ),
    )
    expect(ref.current).toBe(screen.getByTestId('card'))
    expect(screen.getByRole('heading', { level: 3, name: 'Connections' })).toBeInTheDocument()
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.getByText('footer')).toBeInTheDocument()
  })

  it('renders the card as its child when asked, for example as a link', () => {
    render(
      <ChartCard asChild>
        <a href="/performance">Performance</a>
      </ChartCard>,
    )
    expect(screen.getByRole('link', { name: 'Performance' })).toHaveClass('relative')
  })
})

describe('ChartTitle', () => {
  it('has no help button without a tooltip', () => {
    render(<ChartTitle>Connections</ChartTitle>)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers an explanation from a real button that opens on keyboard focus', async () => {
    const user = userEvent.setup()
    render(
      withTooltips(
        <ChartTitle tooltip="Sessions by state, sampled every 30 seconds.">Connections</ChartTitle>,
      ),
    )
    await user.tab()
    const help = screen.getByRole('button', { name: 'What this chart shows' })
    expect(help).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Sessions by state, sampled every 30 seconds.',
    )
  })

  it('takes a custom name for the help button', () => {
    render(
      withTooltips(
        <ChartTitle tooltip="x" helpLabel="About connections">
          Connections
        </ChartTitle>,
      ),
    )
    expect(screen.getByRole('button', { name: 'About connections' })).toBeInTheDocument()
  })
})

describe('ChartActions', () => {
  it('renders icon buttons that are named and call their handler', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      withTooltips(
        <ChartActions
          actions={[{ label: 'Refresh chart', icon: <span aria-hidden>R</span>, onClick }]}
        />,
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Refresh chart' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('renders a link through the link seam', () => {
    function RouterLink({ href, children, ...rest }: LinkComponentProps) {
      return (
        <a href={href} data-router="yes" {...rest}>
          {children}
        </a>
      )
    }
    render(
      withTooltips(
        <LinkProvider component={RouterLink}>
          <ChartActions actions={[{ label: 'Open performance', href: '/performance' }]} />
        </LinkProvider>,
      ),
    )
    const link = screen.getByRole('link', { name: 'Open performance' })
    expect(link).toHaveAttribute('href', '/performance')
    expect(link).toHaveAttribute('data-router', 'yes')
  })

  it('renders children instead of actions and nothing when there is neither', () => {
    const { container, rerender } = render(
      <ChartActions>
        <span>custom</span>
      </ChartActions>,
    )
    expect(screen.getByText('custom')).toBeInTheDocument()
    rerender(<ChartActions />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ChartMetric', () => {
  it('shows a ready value with its label, source and age', () => {
    render(
      withTooltips(
        <ChartMetric
          label="Active sessions"
          now={NOW}
          value={{
            state: 'ready',
            value: '42',
            source: 'sampled',
            observedAt: '2026-10-13T09:56:00Z',
          }}
        />,
      ),
    )
    expect(screen.getByRole('heading', { name: 'Active sessions' })).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(document.querySelector('[data-slot="source-note"]')).toHaveTextContent(
      'Sampled, observed 4 minutes ago',
    )
  })

  it('shows a skeleton while loading, not a value', () => {
    render(<ChartMetric label="Active sessions" value={{ state: 'loading' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading Active sessions')
  })

  it('says it could not read the value instead of showing zero', () => {
    render(
      <ChartMetric
        label="Active sessions"
        value={{
          state: 'failed',
          error: { code: 'NODE_UNREACHABLE', message: 'The node agent did not answer.' },
        }}
      />,
    )
    expect(screen.getByText('Not read')).toBeInTheDocument()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(
      'Could not read Active sessions: The node agent did not answer. This does not mean there is no data.',
    )
    expect(alert).toHaveTextContent('NODE_UNREACHABLE')
    expect(screen.queryByText('0')).toBeNull()
  })

  it('marks a stale value and says why the refresh failed', () => {
    render(
      <ChartMetric
        label="Active sessions"
        now={NOW}
        value={{
          state: 'stale',
          value: '42',
          source: 'cached',
          observedAt: '2026-10-13T09:00:00Z',
          error: { code: 'TIMEOUT', message: 'Timed out.' },
        }}
      />,
    )
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText(/Stale, refreshing failed \(TIMEOUT\)/)).toBeInTheDocument()
    expect(document.querySelector('[data-slot="source-note"]')).toHaveTextContent(
      'observed 1 hour ago',
    )
  })

  it('lists what a partial value is missing', () => {
    render(
      <ChartMetric
        label="Active sessions"
        now={NOW}
        value={{
          state: 'partial',
          value: '30',
          source: 'agent_reported',
          observedAt: '2026-10-13T09:59:00Z',
          missing: ['replica-2: the node agent is offline'],
        }}
      />,
    )
    expect(screen.getByText('30')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toHaveTextContent('replica-2: the node agent is offline')
  })

  it('names a status with a word as well as a dot', () => {
    render(
      <ChartMetric
        label="Replication lag"
        status="degraded"
        value={{ state: 'ready', value: '8 s', source: 'live', observedAt: '2026-10-13T10:00:00Z' }}
        now={NOW}
      />,
    )
    expect(screen.getByText('Degraded')).toBeInTheDocument()
  })

  it('shows a change with its sign in the text', () => {
    render(
      <ChartMetric
        label="Errors"
        diffValue={12}
        now={NOW}
        value={{ state: 'ready', value: '120', source: 'live', observedAt: '2026-10-13T10:00:00Z' }}
      />,
    )
    expect(screen.getByText('+12')).toBeInTheDocument()
  })

  it('explains itself from a help button', async () => {
    const user = userEvent.setup()
    render(
      withTooltips(
        <ChartMetric
          label="Errors"
          tooltip="Errors in the last hour."
          now={NOW}
          value={{ state: 'ready', value: '3', source: 'live', observedAt: '2026-10-13T10:00:00Z' }}
        />,
      ),
    )
    await user.tab()
    expect(screen.getByRole('button', { name: 'About Errors' })).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Errors in the last hour.')
  })

  it('renders hostile text in a label and in a missing entry as text', () => {
    const { container } = render(
      <ChartMetric
        label={'<img src=x onerror=boom()>‮'}
        now={NOW}
        value={{
          state: 'partial',
          value: '1',
          source: 'sampled',
          observedAt: '2026-10-13T09:59:00Z',
          missing: ['<script>boom()</script>'],
        }}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(screen.getByRole('heading')).toHaveTextContent('<img src=x onerror=boom()>⟨U+202E⟩')
  })
})

describe('ChartValueDifferential', () => {
  it('shows the change as text whatever its color', () => {
    render(
      <div>
        <ChartValueDifferential variant="positive">+5</ChartValueDifferential>
        <ChartValueDifferential variant="negative">-5</ChartValueDifferential>
        <ChartValueDifferential>0</ChartValueDifferential>
      </div>,
    )
    expect(screen.getByText('+5')).toBeInTheDocument()
    expect(screen.getByText('-5')).toBeInTheDocument()
  })
})

describe('accessibility', () => {
  it('has no violations for a card with a title, actions and metrics in every state', async () => {
    const { container } = render(
      withTooltips(
        <ChartCard>
          <ChartHeader>
            <ChartTitle tooltip="What it shows.">Connections</ChartTitle>
            <ChartActions
              actions={[
                { label: 'Refresh chart', icon: <span aria-hidden>R</span>, onClick: () => {} },
              ]}
            />
          </ChartHeader>
          <ChartContent>
            <ChartMetric
              label="Active"
              status="healthy"
              diffValue={-3}
              now={NOW}
              value={{
                state: 'ready',
                value: '12',
                source: 'live',
                observedAt: '2026-10-13T10:00:00Z',
              }}
            />
            <ChartMetric label="Idle" value={{ state: 'loading' }} />
            <ChartMetric
              label="Waiting"
              value={{ state: 'failed', error: { code: 'X', message: 'Could not read.' } }}
            />
          </ChartContent>
          <ChartFooter>
            <p>Footer</p>
          </ChartFooter>
        </ChartCard>,
      ),
    )
    expect(await axeViolations(container)).toEqual([])
    const card = container.firstElementChild as HTMLElement
    expect(within(card).getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(1)
  })
})
