import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  advisorRun,
  mountWave9,
  NOW_ISO,
  placedWorld,
  TARGET,
  type Wave9World,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = '/t/shop/platform/staging/advisors'

function finding(id: string) {
  return {
    id,
    kind: 'advisor',
    code: 'unindexed_foreign_key',
    severity: 'warning',
    subject: { targetId: 'tgt_00000000000000000000000002', clusterId: null, nodeId: null },
    summary: 'Foreign key without an index',
    state: 'open',
    occurrences: 2,
    object: 'public.orders',
    securityRelevant: false,
    resolution: null,
    firstSeenAt: NOW_ISO(),
    lastSeenAt: NOW_ISO(),
    resolvedAt: null,
    targetPath: TARGET,
    tier: 'nonprod',
  }
}

function world(): Wave9World {
  const w = placedWorld()
  w.advisorRun = advisorRun()
  w.advisorFindings = (url) =>
    url.searchParams.get('cursor') === null
      ? { items: [finding('fnd_01M4S9000000000000000000F1')], nextCursor: 'next-1' }
      : { items: [finding('fnd_01M4S9000000000000000000F2')], nextCursor: null }
  return w
}

describe('advisors', () => {
  it('runs nothing until asked, then sends the chosen categories', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    expect(await screen.findByText('No advisors ran on this page yet.')).toBeInTheDocument()
    expect(w.sent.filter((s) => s.method === 'POST')).toEqual([])
    await user.click(screen.getByRole('checkbox', { name: 'Change safety' }))
    await user.click(screen.getByRole('button', { name: 'Run advisors' }))
    await waitFor(() =>
      expect(w.sent.find((s) => s.path.endsWith('/advisor-runs'))?.body).toEqual({
        categories: ['security', 'performance', 'change_safety'],
      }),
    )
  })

  it('shows level, rule, object, message, remediation, evidence, skipped rules and the draft affordance', async () => {
    const user = userEvent.setup()
    mountWave9(PATH, world())
    await user.click(await screen.findByRole('button', { name: 'Run advisors' }))
    const row = await waitFor(() => {
      const found = document.querySelector('[data-advisor-result="unindexed_foreign_key"]')
      if (found === null) throw new Error('none')
      return found as HTMLElement
    })
    expect(row).toHaveTextContent('Warning')
    expect(row).toHaveTextContent('The foreign key has no index.')
    expect(row).toHaveTextContent('Create an index on the referencing columns.')
    expect(row.textContent).toContain('⟨U+202E⟩')
    expect(row.querySelector('[data-evidence]')).toHaveTextContent('customer_id')
    // The draft only says a migration draft is possible and links the migrations area.
    const draft = row.querySelector('[data-draft]') as HTMLElement
    expect(draft.querySelector('a')).toHaveAttribute('href', '/t/shop/platform/staging/migrations')
    expect(draft.querySelector('button')).toBeNull()
    expect(document.querySelector('[data-skipped="wraparound_risk"]')).toHaveTextContent(
      'Needs a node agent on the host',
    )
    expect(screen.getByText('A rule that did not run is not a pass.')).toBeInTheDocument()
  })

  it('shows a failed run as a named failure', async () => {
    const user = userEvent.setup()
    const w = world()
    w.refusals.set('advisor-runs', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The advisor run failed.',
    })
    mountWave9(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'Run advisors' }))
    expect(
      await screen.findByRole('heading', { name: 'Could not read advisor results' }),
    ).toBeInTheDocument()
  })

  it('cannot run without a category', async () => {
    const user = userEvent.setup()
    mountWave9(PATH, world())
    await user.click(await screen.findByRole('checkbox', { name: 'Security' }))
    await user.click(screen.getByRole('checkbox', { name: 'Performance' }))
    expect(screen.getByRole('button', { name: 'Run advisors' })).toBeDisabled()
    expect(screen.getByText('Choose at least one category.')).toBeInTheDocument()
  })

  it('lists the open advisor findings by the server cursor, partial while more exist', async () => {
    const user = userEvent.setup()
    const w = world()
    mountWave9(PATH, w)
    await waitFor(() =>
      expect(
        document.querySelector('[data-finding="fnd_01M4S9000000000000000000F1"]'),
      ).not.toBeNull(),
    )
    expect(screen.getByText('Showing part of advisor findings')).toBeInTheDocument()
    const first = w.requests.find((r) => r.startsWith('/api/v1/findings')) ?? ''
    expect(first).toContain('kind=advisor')
    expect(first).toContain('state=open')
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() =>
      expect(
        document.querySelector('[data-finding="fnd_01M4S9000000000000000000F2"]'),
      ).not.toBeNull(),
    )
  })

  it('keeps the earlier findings as stale when the next page fails', async () => {
    const user = userEvent.setup()
    const w = world()
    w.failures.set('cursor=next-1', { status: 503, code: 'STORE_UNAVAILABLE' })
    mountWave9(PATH, w)
    await user.click(await screen.findByRole('button', { name: 'Load more' }))
    expect(
      await screen.findByText('Showing an earlier read of advisor findings'),
    ).toBeInTheDocument()
    expect(document.querySelector('[data-finding="fnd_01M4S9000000000000000000F1"]')).not.toBeNull()
  })

  it('shows a failed findings read as a failure, never as no findings', async () => {
    const w = world()
    w.advisorFindings = undefined
    mountWave9(PATH, w)
    expect(
      await screen.findByRole('heading', { name: 'Could not read advisor findings' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('No advisor finding is open for this target.')).toBeNull()
  })

  it('needs the target reachable', async () => {
    const w = world()
    w.sample(TARGET, { state: 'unreachable' })
    mountWave9(PATH, w)
    expect(
      await screen.findByRole('region', { name: 'The target is unreachable' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run advisors' })).toBeNull()
  })

  it('has no axe violations', async () => {
    const user = userEvent.setup()
    mountWave9(PATH, world())
    await user.click(await screen.findByRole('button', { name: 'Run advisors' }))
    await waitFor(() => expect(document.querySelector('[data-advisor-result]')).not.toBeNull())
    expect(await axeViolations(document.body)).toEqual([])
  })
})
