import '@testing-library/jest-dom/vitest'
import { TooltipProvider } from '@exponetdb/ui'
import { type LinkComponentProps, LinkProvider, type Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { MigrationTimeline } from '../../src/timeline/migration-timeline.tsx'
import type {
  MigrationMarkerState,
  MigrationTimelineData,
  TimelineBundle,
  TimelineCell,
} from '../../src/timeline/types.ts'
import { axeViolations } from '../support/axe.ts'

afterEach(cleanup)

const NOW = '2026-10-13T14:07:30Z'
const OBSERVED = '2026-10-13T14:03:30Z'

const ENVIRONMENTS = [
  { id: 'development', name: 'Development', tier: 'nonprod' },
  { id: 'staging', name: 'Staging', tier: 'nonprod', evidenceFrom: 'development' },
  { id: 'production', name: 'Production', tier: 'prod', evidenceFrom: 'staging' },
]

function cell(
  environmentId: string,
  state: MigrationMarkerState,
  extra: Partial<TimelineCell> = {},
): TimelineCell {
  return { environmentId, state, ...extra }
}

function bundle(
  id: string,
  slug: string,
  dependsOn: string[],
  cells: TimelineCell[],
): TimelineBundle {
  return { id, slug, dependsOn, cells }
}

const BUNDLES: TimelineBundle[] = [
  bundle(
    '01JAAA',
    'add_users',
    [],
    [
      cell('development', 'verified', { at: '2026-10-13T10:00:00Z', observedAt: OBSERVED }),
      cell('staging', 'verified', { at: '2026-10-13T11:00:00Z', observedAt: OBSERVED }),
      cell('production', 'applied', { at: '2026-10-13T12:00:00Z', observedAt: OBSERVED }),
    ],
  ),
  bundle(
    '01JBBB',
    'add_orders',
    ['01JAAA'],
    [
      cell('development', 'verified', { at: '2026-10-13T10:30:00Z', observedAt: OBSERVED }),
      cell('staging', 'failed', { at: '2026-10-13T11:30:00Z', observedAt: OBSERVED }),
      cell('production', 'not_applied', { observedAt: OBSERVED }),
    ],
  ),
  bundle(
    '01JCCC',
    'add_index',
    ['01JBBB'],
    [
      cell('development', 'drifted', { at: '2026-10-13T10:40:00Z', observedAt: OBSERVED }),
      cell('staging', 'pending'),
      cell('production', 'unknown'),
    ],
  ),
]

const DATA: MigrationTimelineData = { environments: ENVIRONMENTS, bundles: BUNDLES }

function ready(value: MigrationTimelineData): Readable<MigrationTimelineData> {
  return { state: 'ready', value, source: 'cached', observedAt: OBSERVED }
}

function renderTimeline(
  readable: Readable<MigrationTimelineData>,
  props: Partial<React.ComponentProps<typeof MigrationTimeline>> = {},
  wrap: (node: ReactNode) => ReactNode = (node) => node,
) {
  return render(
    <TooltipProvider delayDuration={0}>
      {wrap(<MigrationTimeline readable={readable} now={NOW} {...props} />)}
    </TooltipProvider>,
  )
}

function rowFor(slug: string): HTMLElement {
  const header = screen
    .getAllByRole('rowheader')
    .find((candidate) => candidate.textContent?.includes(slug))
  const row = header?.closest('tr')
  if (!row) throw new Error(`no row for ${slug}`)
  return row
}

describe('MigrationTimeline: structure', () => {
  it('is a table with column headers for the environments in the order given and a row header per bundle', () => {
    renderTimeline(ready(DATA))

    const table = screen.getByRole('table', { name: /migration timeline|migration bundles/i })
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map((header) => header.textContent)).toEqual([
      'Migration bundle',
      expect.stringContaining('Development'),
      expect.stringContaining('Staging'),
      expect.stringContaining('Production'),
    ])
    expect(within(table).getAllByRole('rowheader')).toHaveLength(3)
  })

  it('shows the tier of each environment with the production chip on production only', () => {
    const { container } = renderTimeline(ready(DATA))

    const production = [...container.querySelectorAll('[data-tier="production"]')]
    expect(production).toHaveLength(1)
    expect(production[0]).toHaveTextContent('Production')
    expect(screen.getAllByText('Non-production')).toHaveLength(2)
  })

  it('says which environment the evidence of an environment comes from', () => {
    renderTimeline(ready(DATA))

    const staging = screen.getByRole('columnheader', { name: /^Staging/ })
    expect(within(staging).getByText(/Evidence from/)).toHaveTextContent(
      'Evidence from Development',
    )
  })

  it('lists the bundles in dependency order whatever order they arrive in', () => {
    renderTimeline(
      ready({ ...DATA, bundles: [BUNDLES[2], BUNDLES[0], BUNDLES[1]] as TimelineBundle[] }),
    )

    const slugs = screen.getAllByRole('rowheader').map((header) => header.textContent ?? '')
    expect(slugs[0]).toContain('add_users')
    expect(slugs[1]).toContain('add_orders')
    expect(slugs[2]).toContain('add_index')
  })

  it('shows the name and the id of each bundle and what it depends on', () => {
    renderTimeline(ready(DATA))

    const second = screen.getAllByRole('rowheader')[1]
    expect(second).toHaveTextContent('add_orders')
    expect(second).toHaveTextContent('01JBBB')
    expect(second).toHaveTextContent('Depends on 1')
    expect(second).toHaveTextContent('add_users')
    expect(screen.getAllByRole('rowheader')[0]).toHaveTextContent('No dependencies')
  })

  it('names baselines and unlisted ids among the dependencies in words', () => {
    renderTimeline(
      ready({
        ...DATA,
        baselines: ['01BASE'],
        bundles: [bundle('01JAAA', 'add_users', ['01BASE', '01GONE'], [])],
      }),
    )

    const header = screen.getByRole('rowheader')
    expect(header).toHaveTextContent('01BASE (baseline)')
    expect(header).toHaveTextContent('01GONE (not listed)')
  })

  it('names only a few dependencies and offers all of them', async () => {
    const user = userEvent.setup()
    const deps = ['d1', 'd2', 'd3', 'd4', 'd5']
    renderTimeline(
      ready({
        environments: ENVIRONMENTS,
        bundles: [
          ...deps.map((id) => bundle(id, `dep_${id}`, [], [])),
          bundle('z', 'last', deps, []),
        ],
      }),
    )

    const header = rowFor('last').querySelector('th') as HTMLElement
    expect(within(header).queryByText('dep_d5')).toBeNull()
    expect(within(header).getByText('dep_d3')).toBeInTheDocument()

    await user.click(within(header).getByRole('button', { name: 'Show all 5' }))

    expect(within(header).getByText('dep_d5')).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Show fewer' })).toBeInTheDocument()
  })

  it('says where the data comes from and when it was observed', () => {
    renderTimeline(ready(DATA))

    expect(screen.getByText('Cached')).toBeInTheDocument()
    expect(screen.getByText(/Observed/)).toHaveTextContent('4 min ago')
    expect(screen.getByText(/ledger in each target is the source of truth/i)).toBeInTheDocument()
  })

  it('does not scroll the page: the table sits in a named scroll region', () => {
    const { container } = renderTimeline(ready(DATA))

    expect(container.querySelector('table')?.parentElement).toHaveClass('overflow-auto')
  })
})

describe('MigrationTimeline: markers', () => {
  it('shows every state as a word, not only a color', () => {
    renderTimeline(ready(DATA))

    const first = rowFor('add_users')
    expect(within(first).getAllByText('Verified')).toHaveLength(2)
    expect(within(first).getByText('Applied')).toBeInTheDocument()
    const second = rowFor('add_orders')
    expect(within(second).getByText('Failed')).toBeInTheDocument()
    expect(within(second).getByText('Not applied')).toBeInTheDocument()
    const third = rowFor('add_index')
    expect(within(third).getByText('Drifted')).toBeInTheDocument()
    expect(within(third).getByText('Pending')).toBeInTheDocument()
    expect(within(third).getByText('Unknown')).toBeInTheDocument()
  })

  it('gives each state an icon of its own shape', () => {
    const states: MigrationMarkerState[] = [
      'not_applied',
      'pending',
      'applied',
      'verified',
      'failed',
      'drifted',
      'reverted',
      'unknown',
    ]
    const { container } = renderTimeline(
      ready({
        environments: states.map((state) => ({ id: state, name: state, tier: 'nonprod' })),
        bundles: [
          bundle(
            '01A',
            'one',
            [],
            states.map((state) => cell(state, state)),
          ),
        ],
      }),
    )

    const shapes = states.map((state) => {
      const marker = container.querySelector(`[data-marker-state="${state}"]`)
      expect(marker).not.toBeNull()
      const svgs = [...(marker?.querySelectorAll('svg') ?? [])]
      expect(svgs.length).toBeGreaterThan(0)
      for (const svg of svgs) expect(svg).toHaveAttribute('aria-hidden', 'true')
      return (
        svgs.map((svg) => svg.getAttribute('class') ?? '').join('|') +
        svgs.map((svg) => svg.innerHTML).join('|')
      )
    })
    expect(new Set(shapes).size).toBe(states.length)
  })

  it('shows an environment the read has no cell for as unknown, never as not applied', () => {
    renderTimeline(
      ready({
        environments: ENVIRONMENTS,
        bundles: [bundle('01A', 'only_dev', [], [cell('development', 'verified')])],
      }),
    )

    const row = rowFor('only_dev')
    expect(within(row).getAllByText('Unknown')).toHaveLength(2)
    expect(within(row).queryByText('Not applied')).toBeNull()
    expect(
      within(row).getAllByText(/The read holds no record for this environment/),
    ).not.toHaveLength(0)
  })

  it('shows two records for one environment as unknown and says so', () => {
    renderTimeline(
      ready({
        environments: ENVIRONMENTS,
        bundles: [
          bundle('01A', 'twice', [], [cell('staging', 'verified'), cell('staging', 'failed')]),
        ],
      }),
    )

    const row = rowFor('twice')
    expect(within(row).queryByText('Verified')).toBeNull()
    expect(within(row).queryByText('Failed')).toBeNull()
    expect(within(row).getAllByText(/more than one record/).length).toBeGreaterThan(0)
  })

  it('has the time of a marker in the cell for a screen reader, with its meaning', () => {
    renderTimeline(ready(DATA))

    const cellForFirst = within(rowFor('add_users')).getAllByRole('cell')[0] as HTMLElement
    expect(cellForFirst).toHaveTextContent('Verified at 2026-10-13 10:00 UTC (4 h ago)')
    expect(cellForFirst).toHaveTextContent(
      'The mirror was last written at 2026-10-13 14:03 UTC (4 min ago)',
    )
    expect(cellForFirst).toHaveTextContent('Applied, and the latest mirrored verification passed')
  })

  it('does not invent a time: an invalid or missing time is said to be unknown or not recorded', () => {
    renderTimeline(
      ready({
        environments: ENVIRONMENTS,
        bundles: [
          bundle(
            '01A',
            'odd_times',
            [],
            [
              cell('development', 'verified', { at: 'yesterday', observedAt: 'soon' }),
              cell('staging', 'applied'),
            ],
          ),
        ],
      }),
    )

    const cells = within(rowFor('odd_times')).getAllByRole('cell')
    expect(cells[0]).toHaveTextContent('Verified at an unknown time')
    expect(cells[0]).toHaveTextContent('The mirror was last written at an unknown time')
    expect(cells[1]).toHaveTextContent('The time of this state was not recorded')
    expect(cells[1]).toHaveTextContent('The time the mirror was last written was not recorded')
  })

  it('explains the markers in a legend', async () => {
    const user = userEvent.setup()
    renderTimeline(ready(DATA))

    await user.click(screen.getByText('What the markers mean'))

    const legend = screen.getByText('What the markers mean').closest('details') as HTMLElement
    expect(legend).toHaveAttribute('open')
    expect(within(legend).getByText(/does not mean the bundle is absent/)).toBeVisible()
    expect(within(legend).getAllByText(/./, { selector: 'dt [data-marker-state]' })).toHaveLength(8)
  })
})

describe('MigrationTimeline: keyboard and hover', () => {
  it('makes the markers one tab stop and moves between them with the arrow keys', async () => {
    const user = userEvent.setup()
    const { container } = renderTimeline(ready(DATA))

    const stops = container.querySelectorAll('[data-marker-row][tabindex="0"]')
    expect(stops).toHaveLength(1)

    await user.tab()
    const first = container.querySelector('[data-marker-row="0"][data-marker-col="0"]')
    expect(first).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(container.querySelector('[data-marker-row="0"][data-marker-col="1"]')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(container.querySelector('[data-marker-row="1"][data-marker-col="1"]')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(container.querySelector('[data-marker-row="1"][data-marker-col="0"]')).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(container.querySelector('[data-marker-row="0"][data-marker-col="0"]')).toHaveFocus()
    await user.keyboard('{End}')
    expect(container.querySelector('[data-marker-row="0"][data-marker-col="2"]')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(container.querySelector('[data-marker-row="0"][data-marker-col="0"]')).toHaveFocus()
    await user.keyboard('{Control>}{End}{/Control}')
    expect(container.querySelector('[data-marker-row="2"][data-marker-col="2"]')).toHaveFocus()
    await user.keyboard('{Control>}{Home}{/Control}')
    expect(container.querySelector('[data-marker-row="0"][data-marker-col="0"]')).toHaveFocus()
  })

  it('stays at the edge instead of wrapping or leaving the grid', async () => {
    const user = userEvent.setup()
    const { container } = renderTimeline(ready(DATA))

    await user.tab()
    await user.keyboard('{ArrowLeft}{ArrowUp}')

    expect(container.querySelector('[data-marker-row="0"][data-marker-col="0"]')).toHaveFocus()
  })

  it('keeps the marker that had focus as the tab stop', async () => {
    const user = userEvent.setup()
    const { container } = renderTimeline(ready(DATA))

    await user.tab()
    await user.keyboard('{ArrowDown}{ArrowRight}')
    const stops = container.querySelectorAll('[data-marker-row][tabindex="0"]')

    expect(stops).toHaveLength(1)
    expect(stops[0]).toHaveAttribute('data-marker-row', '1')
    expect(stops[0]).toHaveAttribute('data-marker-col', '1')
  })

  it('shows the time on keyboard focus', async () => {
    const user = userEvent.setup()
    renderTimeline(ready(DATA))

    await user.tab()

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Verified at 2026-10-13 10:00 UTC (4 h ago)')
    expect(tooltip).toHaveTextContent('4 min ago')
  })

  it('shows the time on hover', async () => {
    const user = userEvent.setup()
    const { container } = renderTimeline(ready(DATA))

    await user.hover(
      container.querySelector('[data-marker-row="1"][data-marker-col="1"]') as Element,
    )

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Failed')
    expect(tooltip).toHaveTextContent('2026-10-13 11:30 UTC')
  })
})

describe('MigrationTimeline: evidence links', () => {
  const withEvidence = ready({
    environments: ENVIRONMENTS,
    bundles: [
      bundle(
        '01A',
        'with_evidence',
        [],
        [
          cell('development', 'verified', { evidencePath: '/changes/operations/op_1' }),
          cell('staging', 'verified', { evidencePath: 'https://evil.example/phish' }),
          cell('production', 'verified', { evidencePath: '//evil.example/x' }),
        ],
      ),
    ],
  })

  it('links an app path through the link seam, named by its bundle and environment', () => {
    function SeamLink({ href, ...rest }: LinkComponentProps) {
      return <a href={href} data-seam="true" {...rest} />
    }
    renderTimeline(withEvidence, {}, (node) => (
      <LinkProvider component={SeamLink}>{node}</LinkProvider>
    ))

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', '/changes/operations/op_1')
    expect(link).toHaveAttribute('data-seam', 'true')
    expect(link).toHaveAccessibleName(/Evidence.*with_evidence.*01A.*Development/)
  })

  it('never makes a link of an address that is not an app path', () => {
    renderTimeline(withEvidence)

    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(screen.getAllByText('Evidence link not shown')).toHaveLength(2)
    expect(document.querySelector('a[href*="evil"]')).toBeNull()
  })
})

describe('MigrationTimeline: truthful states', () => {
  it('renders a failed read as the failed state, not as an empty timeline', () => {
    renderTimeline({
      state: 'failed',
      error: { code: 'UNAVAILABLE', message: 'The Control Store did not answer.' },
    })

    expect(screen.getByText(/Could not read migration timeline/)).toBeInTheDocument()
    expect(
      screen.getByText(/This does not mean there is no migration timeline/),
    ).toBeInTheDocument()
    expect(screen.getByText('UNAVAILABLE')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('No migration bundles')).toBeNull()
  })

  it('renders a read in progress as loading, not as empty', () => {
    renderTimeline({ state: 'loading' })

    expect(screen.getByRole('status')).toHaveTextContent('Loading migration timeline')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByText('No migration bundles')).toBeNull()
  })

  it('says a successful read of nothing found nothing', () => {
    renderTimeline(ready({ environments: ENVIRONMENTS, bundles: [] }))

    expect(screen.getByText('No migration bundles')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows a partial read under its banner and never as empty', () => {
    renderTimeline({
      state: 'partial',
      value: { environments: ENVIRONMENTS, bundles: [] },
      source: 'cached',
      observedAt: OBSERVED,
      missing: ['production mirror'],
    })

    expect(screen.getByText(/production mirror/)).toBeInTheDocument()
    expect(screen.queryByText('No migration bundles')).toBeNull()
  })

  it('shows a stale read under its banner with the table', () => {
    renderTimeline({
      state: 'stale',
      value: DATA,
      source: 'cached',
      observedAt: '2026-10-13T12:00:00Z',
    })

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText(/Showing an earlier read of migration timeline/)).toBeInTheDocument()
    expect(screen.getAllByText(/2 h ago/).length).toBeGreaterThan(0)
  })
})

describe('MigrationTimeline: hostile content', () => {
  const HOSTILE_SLUG = '<img src=x onerror=alert(1)>\u{202E}drop'
  const HOSTILE_ENV = '<script>alert(2)</script>'

  it('renders slugs, ids and environment names as text with hidden characters made visible', () => {
    const { container } = renderTimeline(
      ready({
        environments: [{ id: 'x', name: HOSTILE_ENV, tier: 'nonprod' }],
        bundles: [
          bundle('01<b>bold</b>', HOSTILE_SLUG, ['<a href=javascript:1>'], [cell('x', 'verified')]),
        ],
      }),
    )

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    const header = screen.getByRole('rowheader')
    expect(header).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(header).toHaveTextContent('⟨U+202E⟩')
    expect(header).toHaveTextContent('<b>bold</b>')
    expect(
      screen.getByRole('columnheader', { name: /<script>alert\(2\)<\/script>/ }),
    ).toBeInTheDocument()
    expect(container.querySelector('[data-segment="hidden"]')).not.toBeNull()
  })

  it('cuts a very long slug and offers the rest explicitly', async () => {
    const user = userEvent.setup()
    const long = `m_${'x'.repeat(500)}`
    renderTimeline(ready({ environments: ENVIRONMENTS, bundles: [bundle('01A', long, [], [])] }))

    const header = screen.getByRole('rowheader')
    expect(header.textContent).not.toContain('x'.repeat(100))
    await user.click(within(header).getByRole('button', { name: /Show all/ }))
    expect(header.textContent).toContain('x'.repeat(500))
  })

  it('does not let a hostile id break out of the evidence link name', () => {
    renderTimeline(
      ready({
        environments: [{ id: 'x', name: 'Dev', tier: 'nonprod' }],
        bundles: [
          bundle('01\u{202E}A', 'm', [], [cell('x', 'verified', { evidencePath: '/changes' })]),
        ],
      }),
    )

    expect(screen.getByRole('link')).toHaveAttribute('href', '/changes')
    expect(screen.getByRole('rowheader')).toHaveTextContent('⟨U+202E⟩')
  })
})

describe('MigrationTimeline: things the data cannot honor', () => {
  it('says so when a dependency cycle keeps bundles out of the order', () => {
    renderTimeline(
      ready({
        environments: ENVIRONMENTS,
        bundles: [
          bundle('A', 'a', ['B'], []),
          bundle('B', 'b', ['A'], []),
          bundle('C', 'c', [], []),
        ],
      }),
    )

    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('2 bundles could not be placed in dependency order')
    expect(
      screen.getAllByRole('rowheader').map((header) => header.textContent?.slice(0, 1)),
    ).toEqual(['c', 'a', 'b'])
  })

  it('says how many bundles the window hides and how many the server cut', () => {
    const bundles = ['01', '02', '03', '04'].map((id) => bundle(id, `m${id}`, [], []))
    renderTimeline(ready({ environments: ENVIRONMENTS, bundles, totalBundleCount: 1_200 }), {
      maxBundles: 2,
    })

    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('lists the last 4 of 1,200 bundles')
    expect(note).toHaveTextContent('Showing the last 2 bundles')
    expect(note).toHaveTextContent('2 earlier bundles are not shown')
    expect(screen.getAllByRole('rowheader')).toHaveLength(2)
  })

  it('has no note when nothing is off', () => {
    renderTimeline(ready(DATA))

    expect(screen.queryByRole('note')).toBeNull()
  })

  it('says when the read lists no environment', () => {
    renderTimeline(ready({ environments: [], bundles: BUNDLES }))

    expect(screen.getByRole('note')).toHaveTextContent('lists no environments')
  })
})

describe('MigrationTimeline: accessibility', () => {
  it('has no axe violations with every state in the grid', async () => {
    renderTimeline(ready(DATA))

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations with evidence links, dependency hints and notes', async () => {
    renderTimeline(
      ready({
        environments: ENVIRONMENTS,
        baselines: ['B0'],
        bundles: [
          bundle('A', 'a', ['B'], [cell('development', 'verified', { evidencePath: '/changes' })]),
          bundle('B', 'b', ['A', 'B0', 'gone'], []),
        ],
      }),
    )

    expect(await axeViolations()).toEqual([])
  })

  it('has no axe violations in the failed, loading and empty states', async () => {
    const { rerender } = renderTimeline({
      state: 'failed',
      error: { code: 'UNAVAILABLE', message: 'The Control Store did not answer.' },
    })
    expect(await axeViolations()).toEqual([])

    rerender(
      <TooltipProvider>
        <MigrationTimeline readable={{ state: 'loading' }} />
      </TooltipProvider>,
    )
    expect(await axeViolations()).toEqual([])

    rerender(
      <TooltipProvider>
        <MigrationTimeline readable={ready({ environments: [], bundles: [] })} />
      </TooltipProvider>,
    )
    expect(await axeViolations()).toEqual([])
  })
})
