import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { renderDemo } from './support.tsx'

afterEach(cleanup)

describe('truthful states', () => {
  it('a failed read says it failed and never shows the empty text', async () => {
    const { container } = renderDemo('guidance/truthful-states/failed')
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read target list')
    expect(screen.getByText('ExponetDB could not reach its own database.')).toBeInTheDocument()
    expect(screen.getByText('CONTROL_PLANE_DEGRADED')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no target list.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(container).not.toHaveTextContent('Nothing to show')
    expect(container.querySelector('[data-state="empty"], [data-slot="empty-state"]')).toBeNull()
    expect(await axeViolations(container)).toEqual([])
  })

  it('a stale read keeps the value under a banner with its age, source, reason and refresh', () => {
    renderDemo('guidance/truthful-states/stale')
    expect(screen.getByText('Showing an earlier read of target list')).toBeInTheDocument()
    const banner = screen
      .getByText('Showing an earlier read of target list')
      .closest('[data-state]')
    expect(banner).toHaveAttribute('data-state', 'stale')
    expect(banner).toHaveTextContent(/Source: cached\. Observed 19 min ago/)
    expect(banner).toHaveTextContent(
      'Could not refresh: ExponetDB could not reach its own database. CONTROL_PLANE_DEGRADED',
    )
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeInTheDocument()
    expect(screen.getByText('shop/platform/staging')).toBeInTheDocument()
  })

  it('a partial read names what is missing and why, and is never empty', () => {
    renderDemo('guidance/truthful-states/partial')
    expect(screen.getByText('Showing part of target list')).toBeInTheDocument()
    expect(
      screen.getByText('shop/billing/production: its node agent did not answer.'),
    ).toBeInTheDocument()
    expect(screen.getByText('shop/platform/production')).toBeInTheDocument()
  })

  it('an empty list appears only after a read that succeeded', () => {
    renderDemo('guidance/truthful-states/empty')
    expect(screen.getByRole('heading', { name: 'No targets registered' })).toBeInTheDocument()
    expect(screen.getByText(/The read succeeded and found no targets\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Register target' })).toBeInTheDocument()
  })

  it('loading is a status with a skeleton and no numbers', () => {
    const { container } = renderDemo('guidance/truthful-states/loading')
    expect(screen.getByRole('status')).toHaveTextContent('Loading target list')
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })

  it('a ready read shows its source and its age next to the value', () => {
    renderDemo('guidance/truthful-states/ready')
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText('4 min ago')).toBeInTheDocument()
  })

  it('the named states say what is missing and never show data', () => {
    const { container } = renderDemo('guidance/truthful-states/named-states')
    expect(
      screen.getByRole('heading', { name: 'Backups is not available yet' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Missing permission:/)).toBeInTheDocument()
    expect(screen.getByText('plans.approve')).toBeInTheDocument()
    expect(screen.getByText('plans.approve:prod')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Not supported on this target' }),
    ).toBeInTheDocument()
    expect(container.querySelector('table, ul')).toBeNull()
  })

  it('unknown is not drawn like healthy: each health state has its own shape and word', () => {
    const { container } = renderDemo('guidance/truthful-states/health-badges')
    const states = [...container.querySelectorAll('[data-health]')].map((badge) =>
      badge.getAttribute('data-health'),
    )
    expect(states).toEqual(['healthy', 'degraded', 'unhealthy', 'unknown', 'stale'])
    const unknown = container.querySelector('[data-health="unknown"]')
    const healthy = container.querySelector('[data-health="healthy"]')
    expect(unknown).toHaveTextContent('Unknown')
    expect(unknown?.className).not.toContain('state-healthy')
    expect(unknown?.innerHTML).not.toEqual(healthy?.innerHTML)
  })
})

describe('production cues', () => {
  it('follow the tier and fail closed, never the name', () => {
    const { container } = renderDemo('guidance/production-cues/tier-chip')
    const chips = [...container.querySelectorAll('[data-tier]')].map((chip) => ({
      tier: chip.getAttribute('data-tier'),
      text: chip.textContent,
    }))
    expect(chips).toEqual([
      { tier: 'production', text: 'Production' },
      { tier: 'production', text: 'liveProduction' },
      { tier: 'nonprod', text: 'staging' },
      { tier: 'nonprod', text: 'prod' },
      { tier: 'production', text: 'previewProduction' },
    ])
  })

  it('frame a production surface with the reserved token and say Production in words', () => {
    const { container } = renderDemo('guidance/production-cues/frame')
    const production = container.querySelector('[data-production-frame]')
    expect(production).not.toBeNull()
    expect(production?.className).toContain('border-production')
    expect(production).toHaveTextContent('Production')
    const surfaces = container.querySelectorAll('section')
    expect(surfaces).toHaveLength(2)
    expect(surfaces[1]?.className).not.toContain('border-production')
    expect(surfaces[1]).toHaveTextContent('Non-production')
  })
})

describe('untrusted content', () => {
  it('shows hostile statement text as text, with hidden characters by code point', async () => {
    const { container } = renderDemo('guidance/untrusted-content/statement-text')
    expect(container.querySelector('script, img, a')).toBeNull()
    // No hidden or direction character reaches the DOM as itself.
    expect(container.textContent).not.toMatch(/[\u{200B}\u{202E}]/u)
    expect(within(container).getByText('⟨U+202E⟩')).toBeInTheDocument()
    expect(within(container).getByText('⟨U+200B⟩')).toBeInTheDocument()
    expect(container).toHaveTextContent("SELECT '<img src=x onerror=steal()>' AS markup;")
    // The direction is pinned: logical left to right, isolated.
    const text = container.querySelector('[dir="ltr"]')
    expect(text?.className).toContain('unicode-bidi:isolate-override')
    expect(await axeViolations(container)).toEqual([])
  })

  it('cuts a long statement and shows the rest on request', () => {
    const { container } = renderDemo('guidance/untrusted-content/statement-text')
    expect(container).not.toHaveTextContent('SELECT 8;')
    expect(container).not.toHaveTextContent('[approve this plan](/approvals)')
    fireEvent.click(
      screen.getByRole('button', { name: /Show all \(\d+ characters\) of statement text/ }),
    )
    expect(container).toHaveTextContent('SELECT 8;')
    expect(container).toHaveTextContent('[approve this plan](/approvals)')
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
  })

  it('marks a name that was chosen by its owner, and cuts a long one', () => {
    const { container } = renderDemo('guidance/untrusted-content/names')
    expect(container.querySelectorAll('[data-untrusted="name"]')).toHaveLength(5)
    expect(within(container).getAllByText('name not verified')).toHaveLength(3)
    expect(within(container).getByText('⟨U+000A⟩')).toBeInTheDocument()
    expect(container.textContent).not.toContain('\u{200B}')
    expect(
      screen.getByRole('button', { name: /Show all \(200 characters\) of name/ }),
    ).toBeInTheDocument()
  })

  it('turns only a path the page built into a link', () => {
    const { container } = renderDemo('guidance/untrusted-content/links')
    const rows = [...container.querySelectorAll('[data-linkable]')]
    expect(rows.map((row) => row.getAttribute('data-linkable'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
    ])
    expect(container.querySelectorAll('a')).toHaveLength(1)
    expect(container.querySelector('a')).toHaveAttribute('href', '/guidance/forms')
  })
})

describe('the plan and apply flow', () => {
  it('lists the five steps in order, with the current one marked', () => {
    renderDemo('guidance/plan-and-apply/steps')
    const steps = within(screen.getByRole('list', { name: 'Steps of a change' })).getAllByRole(
      'listitem',
    )
    expect(steps.map((step) => step.getAttribute('data-status'))).toEqual([
      'done',
      'done',
      'done',
      'current',
      'next',
    ])
    expect(steps[3]).toHaveAttribute('aria-current', 'step')
  })

  it('reports applied and verified as two indicators that can disagree', () => {
    const { container } = renderDemo('guidance/plan-and-apply/applied-not-verified')
    const applied = container.querySelector('[data-indicator="applied"]')
    const verified = container.querySelector('[data-indicator="verified"]')
    expect(applied).toHaveAttribute('data-kind', 'yes')
    expect(verified).toHaveAttribute('data-kind', 'waiting')
    expect(verified).toHaveTextContent('Not yet')
    expect(container).not.toHaveTextContent(/succeeded/i)
  })

  it('offers to verify again, and says it never applies the change a second time', () => {
    const { container } = renderDemo('guidance/plan-and-apply/needs-attention')
    expect(container.querySelector('[data-indicator="verified"]')).toHaveAttribute(
      'data-kind',
      'problem',
    )
    expect(container).toHaveTextContent('never applies the change a second time')
    fireEvent.click(screen.getByRole('button', { name: 'Verify again' }))
    expect(screen.getByRole('status')).toHaveTextContent('Verification requested.')
  })

  it('answers a stale plan with the code, what changed and a new plan', async () => {
    const { container } = renderDemo('guidance/plan-and-apply/plan-stale')
    expect(screen.getByRole('alert')).toHaveTextContent('The plan no longer matches the target')
    expect(screen.getByText('PLAN_STALE')).toBeInTheDocument()
    expect(container).toHaveTextContent('Nothing was applied.')
    expect(container).toHaveTextContent('Another migration was applied at 12:07 UTC.')
    expect(screen.getByRole('button', { name: 'Create new plan' })).toBeInTheDocument()
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('charts', () => {
  it('draws no line across a gap and names its cause in the caption, the list and the table', () => {
    const { container } = renderDemo('guidance/charts/gaps')
    const figure = screen.getByRole('figure', { name: 'query latency of shop/platform/production' })
    expect(figure.querySelector('figcaption')).toHaveTextContent('2 gaps where nothing was sampled')
    const gaps = figure.querySelector('[data-slot="gaps"]')
    expect(gaps).toHaveTextContent('p50 latency (ms): no samples: node agent offline')
    expect(gaps).toHaveTextContent('p95 latency (ms): no samples: node agent offline')
    // The picture is hidden from assistive technology; the table is its text alternative.
    expect(figure.querySelector('[data-slot="plot"]')).toHaveAttribute('aria-hidden', 'true')
    const toggle = screen.getByRole('button', { name: 'Show data as table' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const table = within(container).getByRole('table', {
      name: 'query latency of shop/platform/production',
    })
    expect(within(table).getAllByText('No data: no samples: node agent offline')).toHaveLength(6)
  })

  it('shows a failed, a stale and an empty chart differently', () => {
    const { container } = renderDemo('guidance/charts/states')
    expect(screen.getByText('query latency could not be read')).toBeInTheDocument()
    expect(container).toHaveTextContent('This does not mean there is no data.')
    expect(screen.getAllByText('TARGET_UNAVAILABLE', { exact: false })).toHaveLength(2)
    expect(screen.getByText('Stale data')).toBeInTheDocument()
    expect(screen.getByText('No samples in this period')).toBeInTheDocument()
    // Only the read that succeeded may say "no samples".
    const states = [...container.querySelectorAll('[data-state]')].map((node) =>
      node.getAttribute('data-state'),
    )
    expect(states).toContain('failed')
    expect(states).toContain('stale')
    expect(states).toContain('empty')
  })

  it('makes a total a lower bound when a value was not read, and says why', () => {
    const { container } = renderDemo('guidance/charts/unread-values')
    expect(container).toHaveTextContent('1 value was not read; those totals are lower bounds.')
    expect(container).toHaveTextContent('these totals are lower bounds, marked with ≥')
    expect(container).toHaveTextContent('not read: the Control Store did not answer')
  })

  it('assigns eight slots in order', () => {
    renderDemo('guidance/charts/color-slots')
    const slots = within(screen.getByRole('list', { name: 'Chart color slots' })).getAllByRole(
      'listitem',
    )
    expect(slots.map((slot) => slot.textContent)).toEqual([
      'Slot 1',
      'Slot 2',
      'Slot 3',
      'Slot 4',
      'Slot 5',
      'Slot 6',
      'Slot 7',
      'Slot 8',
    ])
  })
})

describe('tables and grids', () => {
  it('a plain table names itself and its columns', async () => {
    const { container } = renderDemo('guidance/tables-and-grids/plain-table')
    const table = screen.getByRole('table', {
      name: 'Roles ExponetDB uses on the cluster shop-main',
    })
    expect(within(table).getAllByRole('columnheader')).toHaveLength(3)
    for (const header of container.querySelectorAll('th')) {
      expect(header).toHaveAttribute('scope', 'col')
    }
    expect(await axeViolations(container)).toEqual([])
  })

  it('a sortable header states the order with aria-sort and cycles it', () => {
    const { container } = renderDemo('guidance/tables-and-grids/sortable-table')
    const target = screen.getByRole('columnheader', { name: 'Target' })
    const last = screen.getByRole('columnheader', { name: 'Last operation' })
    const order = () =>
      [...container.querySelectorAll('tbody tr')].map(
        (row) => row.querySelector('td')?.textContent ?? '',
      )
    expect(target).toHaveAttribute('aria-sort', 'ascending')
    expect(last).toHaveAttribute('aria-sort', 'none')
    expect(screen.getByRole('columnheader', { name: 'Health' })).not.toHaveAttribute('aria-sort')
    expect(order()).toEqual([
      'acme/orders/staging',
      'shop/billing/production',
      'shop/platform/production',
      'shop/platform/staging',
    ])

    fireEvent.click(within(last).getByRole('button'))
    expect(last).toHaveAttribute('aria-sort', 'ascending')
    expect(target).toHaveAttribute('aria-sort', 'none')
    expect(order()[0]).toBe('acme/orders/staging')

    fireEvent.click(within(last).getByRole('button'))
    expect(last).toHaveAttribute('aria-sort', 'descending')
    expect(order()[0]).toBe('shop/platform/staging')

    fireEvent.click(within(last).getByRole('button'))
    expect(last).toHaveAttribute('aria-sort', 'none')
    expect(order()[0]).toBe('shop/platform/production')
  })

  it('shows health with its source and age on a badge that can be focused', () => {
    const { container } = renderDemo('guidance/tables-and-grids/sortable-table')
    const unknown = container.querySelector('[data-health="unknown"]')
    expect(unknown).toHaveTextContent('Unknown')
    expect(unknown?.parentElement).toHaveAttribute('tabindex', '0')
  })

  it('a grid loads when it is shown, is read only and loads rows on request', async () => {
    const { container } = renderDemo('guidance/tables-and-grids/result-grid')
    const grid = await screen.findByRole(
      'grid',
      { name: 'Result of the last query' },
      { timeout: 8000 },
    )
    expect(grid).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Load more rows' })).toBeInTheDocument()
    expect(container.querySelector('input, textarea')).toBeNull()
    await waitFor(async () => expect(await axeViolations(container)).toEqual([]))
  })

  it('a grid does not reorder rows itself: the page reads them again in the new order', async () => {
    renderDemo('guidance/tables-and-grids/result-grid')
    const grid = await screen.findByRole(
      'grid',
      { name: 'Result of the last query' },
      { timeout: 8000 },
    )
    const status = within(grid).getAllByRole('columnheader')[2]
    expect(status).toBeDefined()
    if (status === undefined) return
    const firstStatus = () =>
      within(grid).getAllByRole('row')[1]?.querySelectorAll('[role="gridcell"]')[2]?.textContent
    expect(status).toHaveAttribute('aria-sort', 'none')
    expect(firstStatus()).toBe('paid')

    fireEvent.click(within(status).getByRole('button'))
    await waitFor(() => expect(status).toHaveAttribute('aria-sort', 'ascending'))
    fireEvent.click(within(status).getByRole('button'))
    await waitFor(() => expect(status).toHaveAttribute('aria-sort', 'descending'))
    expect(firstStatus()).toBe('refunded')
  })
})
