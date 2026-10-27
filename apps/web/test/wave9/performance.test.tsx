import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  BIDI,
  mountWave9,
  placedWorld,
  queryStats,
  tableStats,
  type Wave9World,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = '/t/shop/platform/staging/performance'

function world(): Wave9World {
  const w = placedWorld()
  w.queryStats = queryStats()
  w.tableStats = tableStats()
  return w
}

const statementsRegion = () => screen.findByRole('region', { name: 'Statements' })

describe('performance: statements', () => {
  it('shows the sampled statements with calls, times, rows and blocks', async () => {
    mountWave9(PATH, world())
    const row = await screen.findByText('select * from orders where id = $1')
    const tr = row.closest('tr') as HTMLElement
    expect(tr).toHaveTextContent('1,200')
    expect(tr).toHaveTextContent('3,401 ms')
    expect(tr).toHaveTextContent('2.8 ms')
    expect(tr).toHaveTextContent('9,000 hit')
    expect(tr).toHaveTextContent('12 read')
    expect(screen.getByText(/Sampled every 300 s/)).toBeInTheDocument()
  })

  it('names a regression with its factor and as a time coincidence, never a cause', async () => {
    mountWave9(PATH, world())
    const note = await waitFor(() => {
      const found = document.querySelector('[data-regression="regressed"]')
      if (found === null) throw new Error('no regression note')
      return found as HTMLElement
    })
    expect(note).toHaveTextContent('Slower ×2.6')
    expect(note).toHaveTextContent(
      'Time coincidence with 2 migrations applied in between, not a proven cause.',
    )
  })

  it('marks redacted text and shows hidden characters of the statement by code point', async () => {
    const w = world()
    const base = queryStats()
    const first = base.statements[0]
    if (first === undefined) throw new Error('fixture')
    w.queryStats = queryStats({
      statements: [{ ...first, normalizedText: `select 1 ${BIDI}-- x`, textRedacted: true }],
    })
    mountWave9(PATH, w)
    const marker = await waitFor(() => {
      const found = document.querySelector('[data-redacted]')
      if (found === null) throw new Error('no marker')
      return found as HTMLElement
    })
    expect(marker).toHaveTextContent('Redacted')
    expect(document.body.textContent).toContain('⟨U+202E⟩')
  })

  it('shows resets and gaps on the window', async () => {
    const w = world()
    w.queryStats = queryStats({
      sampling: {
        state: 'active',
        intervalSeconds: 300,
        lastSampleAt: new Date().toISOString(),
        lastErrorCode: null,
        resets: [{ at: '2026-10-26T03:00:00.000Z', kind: 'server_restart' }],
        gaps: [{ from: '2026-10-26T04:00:00.000Z', to: '2026-10-26T05:00:00.000Z' }],
      },
    })
    mountWave9(PATH, w)
    expect(await screen.findByText(/The server restarted at/)).toBeInTheDocument()
    expect(document.querySelector('[data-gap]')).toHaveTextContent('No sample')
  })

  it.each([
    ['extension_missing', 'The pg_stat_statements extension is not available'],
    ['not_permitted', 'Statements of other roles cannot be read'],
    ['failing', 'Sampling is failing'],
    ['not_sampled_yet', 'Not sampled yet'],
  ] as const)('names the sampler state %s in a banner', async (state, title) => {
    const w = world()
    w.queryStats = queryStats({
      statements: [],
      sampling: {
        state,
        intervalSeconds: 300,
        lastSampleAt: null,
        lastErrorCode: state === 'failing' ? 'TARGET_UNAVAILABLE' : null,
        resets: [],
        gaps: [],
      },
    })
    mountWave9(PATH, w)
    expect(await screen.findByText(title)).toBeInTheDocument()
    // A sampler that cannot sample is never "no statement ran".
    expect(screen.queryByText('No statement ran in this window.')).toBeNull()
  })

  it('names CAPABILITY_UNAVAILABLE as the missing extension, not an empty list', async () => {
    const w = world()
    w.failures.set('/query-stats', {
      status: 409,
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'The node does not report this capability version, or the cluster is external.',
    })
    mountWave9(PATH, w)
    expect(
      await screen.findByRole('heading', {
        name: 'The pg_stat_statements extension is not available',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No statement ran in this window.')).toBeNull()
  })

  it('shows a failed read (a route that is not there yet) as a named failure', async () => {
    const w = world()
    w.queryStats = undefined
    mountWave9(PATH, w)
    expect(
      await screen.findByRole('heading', { name: 'Could not read statement statistics' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('This does not mean there is no statement statistics.'),
    ).toBeInTheDocument()
  })

  it('shows loading while the read runs', async () => {
    const w = world()
    w.delays.set('/query-stats', new Promise(() => {}))
    mountWave9(PATH, w)
    expect(await screen.findByText('Loading statement statistics')).toBeInTheDocument()
  })

  it('says an empty window was read and found nothing', async () => {
    const w = world()
    w.queryStats = queryStats({ statements: [] })
    mountWave9(PATH, w)
    expect(await screen.findByText('No statement ran in this window.')).toBeInTheDocument()
  })

  it('shows a cut list as partial and an old sample as stale', async () => {
    const w = world()
    w.queryStats = queryStats({ truncated: true })
    mountWave9(PATH, w)
    expect(await screen.findByText('Showing part of statement statistics')).toBeInTheDocument()
    cleanup()
    const old = world()
    old.queryStats = queryStats({ observedAt: new Date(Date.now() - 3_600_000).toISOString() })
    mountWave9(PATH, old)
    expect(
      await screen.findByText('Showing an earlier read of statement statistics'),
    ).toBeInTheDocument()
  })

  it('asks the server for the chosen window, order and limit', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    await screen.findByText('select * from orders where id = $1')
    await user.selectOptions(screen.getByLabelText('Window'), 'Last hour')
    await user.selectOptions(screen.getByLabelText('Order by'), 'Mean time')
    await user.selectOptions(screen.getByLabelText('Show up to'), '500 statements')
    await waitFor(() => {
      const last = w.requests.filter((r) => r.includes('/query-stats')).at(-1) ?? ''
      const query = new URL(last, 'http://x').searchParams
      expect(query.get('order')).toBe('mean_time')
      expect(query.get('limit')).toBe('500')
      const span = Date.parse(query.get('to') ?? '') - Date.parse(query.get('from') ?? '')
      expect(span).toBe(3_600_000)
    })
  })

  it('has no axe violations', async () => {
    mountWave9(PATH, world())
    await statementsRegion()
    await screen.findByText('select * from orders where id = $1')
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('performance: tables and indexes', () => {
  async function openTables(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('tab', { name: 'Tables and indexes' }))
  }

  it('reads live statistics only when the tab opens, and marks unused, duplicate and invalid indexes', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    await screen.findByText('select * from orders where id = $1')
    expect(w.requests.some((r) => r.includes('/table-stats'))).toBe(false)
    await openTables(user)
    const unused = await waitFor(() => {
      const found = document.querySelector('[data-marker="unused"]')
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(unused).toHaveTextContent(/Unused\s*Since/)
    // A primary key with no scans is not "unused".
    expect(document.querySelectorAll('[data-marker="unused"]')).toHaveLength(1)
    expect(document.querySelector('[data-marker="duplicate"]')).toHaveTextContent(
      'Duplicate of orders_status_idx',
    )
    expect(document.querySelector('[data-marker="invalid"]')).toHaveTextContent('Invalid')
    expect(document.querySelector('[data-bloat]')).toHaveTextContent('Estimate')
    expect(screen.getByText(/Statistics count since/)).toBeInTheDocument()
  })

  it('says an unused index cannot be dated without statsSince', async () => {
    const user = userEvent.setup()
    const w = world()
    w.tableStats = tableStats({ statsSince: null })
    mountWave9(PATH, w)
    await openTables(user)
    expect(await screen.findByText('Since an unknown time')).toBeInTheDocument()
  })

  it('filters by schema through the server', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    await openTables(user)
    await screen.findByText('orders_status_idx2')
    await user.type(screen.getByLabelText('Schema'), 'billing')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() =>
      expect(
        w.requests.some((r) => r.includes('/table-stats') && r.includes('schema=billing')),
      ).toBe(true),
    )
  })

  it('says it cannot tell when the target cannot be read now', async () => {
    const user = userEvent.setup()
    const w = world()
    w.failures.set('/table-stats', { status: 503, code: 'TARGET_UNAVAILABLE' })
    mountWave9(PATH, w)
    await openTables(user)
    const region = await waitFor(() => {
      const found = document.querySelector('[data-state="cannot-tell"]')
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(within(region).getByText(/TARGET_UNAVAILABLE/)).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const user = userEvent.setup()
    mountWave9(PATH, world())
    await openTables(user)
    await screen.findByText('orders_status_idx2')
    expect(await axeViolations(document.body)).toEqual([])
  })
})
