import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { filtersOf, findingsSearch, searchString } from '../../src/features/findings/search.ts'
import {
  BIDI,
  finding,
  HOSTILE,
  mountOps,
  OpsWorld,
  project,
  TARGET,
  ulid,
  withDefaults,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PAGE = `/t/${TARGET}/findings`
const FINDINGS = /\/api\/v1\/findings\?/

function world(items: unknown[] = [finding(1), finding(2, { kind: 'health', code: 'disk_low' })]) {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  withDefaults(w)
  w.on('GET', FINDINGS, { items, nextCursor: null })
  return w
}

describe('the findings search parameters', () => {
  it('keeps only allowlist values and drops the rest', () => {
    expect(findingsSearch({ severity: 'critical', state: 'all', kind: 'drift' })).toEqual({
      severity: 'critical',
      state: 'all',
      kind: 'drift',
    })
    expect(findingsSearch({ severity: '<script>', state: ['open'], kind: 'DROP TABLE x' })).toEqual(
      { severity: undefined, state: undefined, kind: undefined },
    )
    expect(filtersOf({})).toEqual({ state: 'open' })
    expect(searchString({ severity: 'info', state: 'open', kind: 'health' })).toBe(
      '?severity=info&kind=health',
    )
  })
})

describe('the findings page', () => {
  it('reads the open findings of this target and lists kind, severity, object, times and state', async () => {
    const w = world()
    mountOps(PAGE, w)
    const table = await screen.findByRole('table', {
      name: 'Findings of this target, newest first',
    })
    expect(within(table).getByText('public.orders_1')).toBeInTheDocument()
    expect(within(table).getAllByText('Warning').length).toBeGreaterThan(0)
    expect(within(table).getAllByText(/First seen/).length).toBe(2)
    const [call] = w.callsTo('GET', FINDINGS)
    const query = new URL(call?.url ?? '', 'http://x').searchParams
    expect(query.get('target')).toBe(TARGET)
    expect(query.get('state')).toBe('open')
    expect(query.get('limit')).toBe('50')
  })

  it('passes validated filters from the address to the request', async () => {
    const w = world()
    mountOps(`${PAGE}?severity=critical&state=all&kind=drift`, w)
    await screen.findByRole('table', { name: 'Findings of this target, newest first' })
    const query = new URL(w.callsTo('GET', FINDINGS)[0]?.url ?? '', 'http://x').searchParams
    expect([query.get('severity'), query.get('state'), query.get('kind')]).toEqual([
      'critical',
      'all',
      'drift',
    ])
    expect(screen.getByLabelText('Severity')).toHaveValue('critical')
    expect(screen.getByLabelText('State')).toHaveValue('all')
  })

  it('ignores a hostile filter in the address', async () => {
    const w = world()
    mountOps(`${PAGE}?severity=%3Cscript%3E&state=bogus&kind=%00`, w)
    await screen.findByRole('table', { name: 'Findings of this target, newest first' })
    const query = new URL(w.callsTo('GET', FINDINGS)[0]?.url ?? '', 'http://x').searchParams
    expect(query.get('severity')).toBeNull()
    expect(query.get('state')).toBe('open')
    expect(query.get('kind')).toBeNull()
  })

  it('changes the filter through the address', async () => {
    const w = world()
    const { router } = mountOps(PAGE, w)
    const user = userEvent.setup()
    await screen.findByRole('table', { name: 'Findings of this target, newest first' })
    await user.selectOptions(screen.getByLabelText('Severity'), 'warning')
    await waitFor(() => expect(router.state.location.search).toMatchObject({ severity: 'warning' }))
    await waitFor(() =>
      expect(w.callsTo('GET', FINDINGS).some((call) => call.url.includes('severity=warning'))).toBe(
        true,
      ),
    )
  })

  it('loads more with the server cursor', async () => {
    const w = world()
    w.on('GET', FINDINGS, (request) =>
      request.url.includes('cursor=next')
        ? { status: 200, body: { items: [finding(3)], nextCursor: null } }
        : { status: 200, body: { items: [finding(1)], nextCursor: 'next' } },
    )
    mountOps(PAGE, w)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Load more findings' }))
    await screen.findByText('public.orders_3')
    expect(screen.getByText('public.orders_1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more findings' })).toBeNull()
  })

  it('shows a failed read as failed and an empty list only after success', async () => {
    const failing = world()
    failing.fail('GET', FINDINGS, 500, 'INTERNAL_ERROR')
    mountOps(PAGE, failing)
    expect(await screen.findByText(/Could not read findings/)).toBeInTheDocument()
    expect(document.querySelector('[data-empty="findings"]')).toBeNull()
    cleanup()
    mountOps(PAGE, world([]))
    expect(
      await screen.findByText('The read succeeded: this target has no open finding.'),
    ).toBeInTheDocument()
    cleanup()
    mountOps(`${PAGE}?severity=info`, world([]))
    expect(
      await screen.findByText('The read succeeded: no finding matches these filters.'),
    ).toBeInTheDocument()
  })

  it('links a drift finding to the drift page and offers accept drift only for open drift', async () => {
    const w = world([
      finding(1),
      finding(2, { state: 'resolved', resolution: 'accepted' }),
      finding(3, { kind: 'health', code: 'disk_low' }),
    ])
    mountOps(`${PAGE}?state=all`, w)
    const table = await screen.findByRole('table', {
      name: 'Findings of this target, newest first',
    })
    expect(within(table).getAllByRole('link', { name: 'Open on the Drift page' })).toHaveLength(2)
    expect(
      within(table).getAllByRole('link', { name: 'Open on the Drift page' })[0],
    ).toHaveAttribute('href', `/t/${TARGET}/drift`)
    expect(table.querySelectorAll('[data-accept-drift]')).toHaveLength(1)
    expect(table.querySelector(`[data-accept-drift="fnd_${ulid(1)}"]`)).not.toBeNull()
    expect(within(table).getByText('accepted')).toBeInTheDocument()
  })

  it('renders hostile finding text as marked text', async () => {
    mountOps(
      PAGE,
      world([finding(1, { summary: HOSTILE, object: `public.${HOSTILE}`, code: `x${BIDI}y` })]),
    )
    const table = await screen.findByRole('table', {
      name: 'Findings of this target, newest first',
    })
    expect(table.querySelector('script')).toBeNull()
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
  })

  it('has no accessibility violations', async () => {
    mountOps(PAGE, world())
    await screen.findByRole('table', { name: 'Findings of this target, newest first' })
    expect(await axeViolations(document.body)).toEqual([])
  })

  it('wears the production frame on a production target', async () => {
    const w = new OpsWorld()
    project(w)
    w.sample('shop/platform/production')
    withDefaults(w, 'shop/platform/production')
    w.on('GET', FINDINGS, { items: [], nextCursor: null })
    mountOps('/t/shop/platform/production/findings', w)
    await screen.findByText(/no open finding/)
    expect(document.querySelector('[data-production-frame]')).not.toBeNull()
  })
})
