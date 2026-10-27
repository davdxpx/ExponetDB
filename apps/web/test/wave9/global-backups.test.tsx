import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  CLUSTER,
  catalog,
  mountWave9,
  overview,
  placedWorld,
  protection,
  Wave9World,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

function world(): Wave9World {
  const w = new Wave9World()
  w.permissions = ['backups.read']
  w.overview = (url) =>
    url.searchParams.get('cursor') === null
      ? overview({ nextCursor: 'page-2' })
      : overview({
          clusters: [
            {
              clusterId: 'cls_01M4S9000000000000000000AG',
              serverId: null,
              displayName: 'second',
              managementMode: 'external',
              repositories: 0,
              protection: protection({ state: 'unprotected', reasons: ['no_repository'] }),
            },
          ],
        })
  return w
}

describe('the global backups page', () => {
  it('shows counts per state, the paged clusters (partial while more exist) and links each to its cluster page', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9('/backups', w)
    const row = await waitFor(() => {
      const found = document.querySelector(`[data-cluster="${CLUSTER}"]`)
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(within(row).getByRole('link')).toHaveAttribute(
      'href',
      `/infrastructure/clusters/${CLUSTER}`,
    )
    expect(row.textContent).toContain('⟨U+202E⟩')
    expect(row.querySelector('[data-protection]')).toHaveAttribute('data-tone', 'neutral')
    expect(document.querySelector('[data-count="unknown"]')).toHaveTextContent('4')
    expect(document.querySelector('[data-count="protected"]')).toHaveTextContent('2')
    expect(screen.getByText('Showing part of backup protection')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() =>
      expect(
        document.querySelector('[data-cluster="cls_01M4S9000000000000000000AG"]'),
      ).not.toBeNull(),
    )
  })

  it('keeps the state filter in the address and asks the server for it', async () => {
    const user = userEvent.setup()
    const w = world()
    const { router } = mountWave9('/backups?state=at_risk', w)
    await waitFor(() =>
      expect(
        w.requests.some(
          (r) => r.startsWith('/api/v1/backups/overview') && r.includes('state=at_risk'),
        ),
      ).toBe(true),
    )
    expect(screen.getByLabelText('Protection')).toHaveValue('at_risk')
    await user.selectOptions(screen.getByLabelText('Protection'), 'Unproven')
    await waitFor(() => expect(router.state.location.search).toEqual({ state: 'unproven' }))
    await waitFor(() => expect(w.requests.some((r) => r.includes('state=unproven'))).toBe(true))
  })

  it('drops a state that is not one of the contract values', async () => {
    const w = world()
    mountWave9('/backups?state=%3Cscript%3E', w)
    await waitFor(() =>
      expect(w.requests.some((r) => r.startsWith('/api/v1/backups/overview'))).toBe(true),
    )
    expect(
      w.requests
        .filter((r) => r.startsWith('/api/v1/backups/overview'))
        .every((r) => !r.includes('state=')),
    ).toBe(true)
  })

  it('shows a failed read as a named failure, never as no clusters', async () => {
    const w = world()
    w.overview = undefined
    mountWave9('/backups', w)
    expect(
      await screen.findByRole('heading', { name: 'Could not read backup protection' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No cluster is visible to you.')).toBeNull()
  })

  it('shows an old overview as stale', async () => {
    const w = world()
    w.overview = overview({ observedAt: new Date(Date.now() - 3_600_000).toISOString() })
    mountWave9('/backups', w)
    expect(
      await screen.findByText('Showing an earlier read of backup protection'),
    ).toBeInTheDocument()
  })

  it('says an empty read found no cluster', async () => {
    const w = world()
    w.overview = overview({
      clusters: [],
      counts: { protected: 0, atRisk: 0, unprotected: 0, unproven: 0, unknown: 0 },
    })
    mountWave9('/backups', w)
    expect(await screen.findByText('No cluster is visible to you.')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    mountWave9('/backups', world())
    await waitFor(() =>
      expect(document.querySelector(`[data-cluster="${CLUSTER}"]`)).not.toBeNull(),
    )
    expect(await axeViolations(document.body)).toEqual([])
  })
})

describe('the overview slot and the target fact', () => {
  it('shows the counts in the overview slot, each linking to the filtered page', async () => {
    const w = world()
    mountWave9('/', w)
    const slot = (await screen.findByRole('heading', { name: 'Backups' })).closest(
      '[data-slot="fleet-backups"]',
    ) as HTMLElement
    await waitFor(() =>
      expect(slot.querySelector('[data-count="unproven"]')).toHaveTextContent('3'),
    )
    expect(
      within(slot.querySelector('[data-count="at_risk"]') as HTMLElement).getByRole('link'),
    ).toHaveAttribute('href', '/backups?state=at_risk')
    // The slot asks for counts only.
    expect(w.requests.find((r) => r.startsWith('/api/v1/backups/overview'))).toContain('limit=1')
  })

  it('shows a failed overview read in the slot, never a zero', async () => {
    const w = world()
    w.overview = undefined
    mountWave9('/', w)
    const slot = (await screen.findByRole('heading', { name: 'Backups' })).closest(
      '[data-slot="fleet-backups"]',
    ) as HTMLElement
    expect(await within(slot).findByText('Could not read backup protection')).toBeInTheDocument()
    expect(slot.querySelector('[data-count]')).toBeNull()
  })

  it("shows the target cluster's protection state in the hero, linked to the backups page", async () => {
    const w = placedWorld()
    w.catalog = catalog()
    mountWave9('/t/shop/platform/staging', w)
    const fact = await waitFor(() => {
      const found = document.querySelector('[data-fact-state]')
      if (found === null || found.getAttribute('data-fact-state') === 'failed')
        throw new Error('none')
      return found as HTMLElement
    })
    expect(fact).toHaveAttribute('href', '/t/shop/platform/staging/backups')
    expect(fact).toHaveTextContent('Unproven')
    expect(fact.querySelector('[data-tone="good"]')).toBeNull()
  })

  it('names a failed fact read with its code', async () => {
    const w = placedWorld()
    mountWave9('/t/shop/platform/staging', w)
    expect(await screen.findByText('Could not read (NOT_FOUND)')).toBeInTheDocument()
  })
})
