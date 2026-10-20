import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  auditEvent,
  finding,
  mountOps,
  OpsWorld,
  operation,
  project,
  TARGET,
  withDefaults,
} from '../target-pages/support.tsx'

/**
 * Read states of the target pages that their own test files do not name: an old (stale) read and
 * a partial one. A stale read is made the way it happens: the list was read, then the next read
 * fails, so the page keeps the value under a banner with its age and a refresh.
 */

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const AUDIT = /\/api\/v1\/audit-events\?/
const OPERATIONS = /\/api\/v1\/operations\?/
const FINDINGS = /\/api\/v1\/findings\?/

function world(): OpsWorld {
  const w = new OpsWorld()
  project(w)
  w.sample(TARGET)
  return withDefaults(w)
}

async function staleAfterFailure(
  w: OpsWorld,
  queryClient: { refetchQueries: () => Promise<void> },
  failing: readonly RegExp[],
  what: string,
): Promise<void> {
  for (const pattern of failing) w.fail('GET', pattern, 400, 'VALIDATION_FAILED')
  await act(async () => {
    await queryClient.refetchQueries()
  })
  await waitFor(() =>
    expect(
      screen.getAllByText(new RegExp(`Showing an earlier read of ${what}`, 'i')).length,
    ).toBeGreaterThan(0),
  )
  const banner = document.querySelector('[data-state="stale"]')
  expect(banner?.textContent).toMatch(/Observed .*ago|Observed/)
  expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
}

describe('the activity page', () => {
  it('shows an old read of the audit events and operations as stale, with their age and a refresh', async () => {
    const w = world()
    const { queryClient } = mountOps(`/t/${TARGET}/activity`, w)
    await screen.findByRole('list', { name: 'Audit events of this target, newest first' })
    // Both reads must have succeeded once before they fail: on a loaded machine the
    // operations read could still be in its first fetch, which would then fail with no
    // earlier read to show (a failed state, rightly not a stale one).
    await screen.findByRole('table', { name: 'Operations on this target, newest first' })
    await staleAfterFailure(w, queryClient, [AUDIT, OPERATIONS], 'Audit events')
    expect(
      screen.getByRole('list', { name: 'Audit events of this target, newest first' }),
    ).toBeVisible()
    expect(screen.getAllByText(/Showing an earlier read of operations/i).length).toBeGreaterThan(0)
  })

  it('names what is missing when more operations exist than the pages read, never as empty', async () => {
    const w = world()
    w.on('GET', OPERATIONS, { items: [operation(1)], nextCursor: 'c2' })
    mountOps(`/t/${TARGET}/activity`, w)
    expect(await screen.findByText(/Showing part of operations/)).toBeInTheDocument()
    expect(screen.getByText(/More operations exist than the pages read so far/)).toBeInTheDocument()
    expect(screen.queryByText(/found no operations/)).toBeNull()
  })

  it('names what is missing when more audit events exist than the pages read, never as empty', async () => {
    const w = world()
    w.on('GET', AUDIT, { items: [auditEvent(1)], nextCursor: 'c2' })
    mountOps(`/t/${TARGET}/activity`, w)
    expect(await screen.findByText(/Showing part of audit events/)).toBeInTheDocument()
    expect(screen.queryByText(/found no audit events/)).toBeNull()
  })
})

describe('the findings page', () => {
  it('shows an old read as stale with its age and a refresh, keeping the findings', async () => {
    const w = world()
    w.on('GET', FINDINGS, { items: [finding(1)], nextCursor: null })
    const { queryClient } = mountOps(`/t/${TARGET}/findings`, w)
    await screen.findByText('public.orders_1')
    await staleAfterFailure(w, queryClient, [FINDINGS], 'Findings')
    expect(screen.getByText('public.orders_1')).toBeInTheDocument()
  })

  it('names what is missing when more findings exist than the pages read, never as empty', async () => {
    const w = world()
    w.on('GET', FINDINGS, { items: [], nextCursor: 'next' })
    mountOps(`/t/${TARGET}/findings`, w)
    expect(
      await screen.findByText(/More findings exist than the pages read so far/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/found no findings/)).toBeNull()
  })
})

describe('the drift page', () => {
  it('shows an old read as stale with its age and a refresh, keeping the findings', async () => {
    const w = world()
    w.on('GET', FINDINGS, { items: [finding(1)], nextCursor: null })
    const { queryClient } = mountOps(`/t/${TARGET}/drift`, w)
    await screen.findByRole('table', { name: 'Open drift findings of this target' })
    await staleAfterFailure(w, queryClient, [FINDINGS], 'Open drift findings')
    expect(screen.getByRole('table', { name: 'Open drift findings of this target' })).toBeVisible()
  })
})
