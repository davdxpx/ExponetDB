import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { infraKeys } from '../../src/features/infrastructure/keys.ts'
import { secretExposure } from '../security/secret-scan.ts'
import {
  BIDI,
  cacheText,
  enrollPlan,
  job,
  mountApp,
  NODE,
  node,
  nodeStatus,
  PLAN,
  SERVER,
  server,
  TOKEN,
  TOKEN_ID,
  World,
} from './support.tsx'

afterEach(cleanup)

const DETAIL = `/infrastructure/nodes/${NODE}`

async function confirmWithCode(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  const reauth = await screen.findByRole('dialog', { name: 'Confirm it is you' })
  fireEvent.change(within(reauth).getByLabelText('Or enter the code from your authenticator app'), {
    target: { value: '123456' },
  })
  await user.click(within(reauth).getByRole('button', { name: 'Confirm with code' }))
}

describe('the nodes page', () => {
  it('lists every state, and only an active node is green', async () => {
    const world = new World()
    const states = ['active', 'unknown', 'pending_enrollment', 'offline', 'revoked'] as const
    world.nodes = states.map((state, i) => node({ id: `nod_01M4S900000000000000000${i}N0`, state }))
    const { container } = mountApp('/infrastructure/nodes', world)
    const table = await screen.findByRole('table', { name: 'Nodes' })
    const green = [...table.querySelectorAll('[data-health="healthy"]')]
    expect(green).toHaveLength(1)
    const unknownRow = table.querySelector('[data-node-state="unknown"]')
    expect(unknownRow?.querySelector('[data-health="unknown"]')).not.toBeNull()
    expect(
      table.querySelector('[data-node-state="pending_enrollment"] [data-health="unknown"]'),
    ).not.toBeNull()
    expect(table.textContent).toContain('Offline: no heartbeat within 60 s')
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows a failed read as failed, never as an empty list', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/nodes', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    mountApp('/infrastructure/nodes', world)
    expect(await screen.findByText('Could not read Node list')).toBeInTheDocument()
    expect(screen.queryByText('No nodes yet')).toBeNull()
  })

  it('shows an old read as stale with its age and a refresh', async () => {
    const world = new World()
    world.hang.add('GET /api/v1/nodes')
    mountApp('/infrastructure/nodes', world, (queryClient) =>
      queryClient.setQueryData(
        infraKeys.nodes(),
        { items: [node()], nextCursor: null },
        { updatedAt: Date.now() - 5 * 60_000 },
      ),
    )
    expect(await screen.findByText('Showing an earlier read of Node list')).toBeInTheDocument()
    expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
      /Observed [45] min ago/,
    )
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
  })

  it('says what is missing from a partial list and never shows it as empty', async () => {
    const world = new World()
    world.nodes = []
    world.nodesNextCursor = 'next'
    mountApp('/infrastructure/nodes', world)
    expect(await screen.findByText('Items after the first 200')).toBeInTheDocument()
    expect(screen.queryByText('No nodes yet')).toBeNull()
  })

  it('is empty only after a successful read', async () => {
    const world = new World()
    world.nodes = []
    mountApp('/infrastructure/nodes', world)
    expect(await screen.findByText('No nodes yet')).toBeInTheDocument()
    expect(screen.queryByText('Could not read Node list')).toBeNull()
  })

  it('shows an old read of the node as stale with its age and a refresh', async () => {
    const world = new World()
    world.hang.add(`GET /api/v1/nodes/${NODE}`)
    mountApp(DETAIL, world, (queryClient) =>
      queryClient.setQueryData(infraKeys.node(NODE), {
        ...world.status,
        observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      }),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-state="stale"]')?.textContent).toMatch(
        /Observed [45] min ago/,
      ),
    )
    expect(screen.getAllByRole('button', { name: 'Refresh' }).length).toBeGreaterThan(0)
  })

  it('warns about a clock skew beyond 30 s and shows a hostile version as text', async () => {
    const world = new World()
    world.nodes = [node({ clockSkewMs: -45_000, agentVersion: `1.0.0${BIDI}` })]
    mountApp('/infrastructure/nodes', world)
    const table = await screen.findByRole('table', { name: 'Nodes' })
    expect(table.querySelector('[data-skew="beyond"]')?.textContent).toContain(
      '-45000 ms (beyond the 30 s jobs tolerate)',
    )
    expect(table.textContent).toContain('⟨U+202E⟩')
    expect(table.textContent).not.toContain(BIDI)
  })
})

describe('the node page', () => {
  it('shows status, capabilities, host, clusters and recent jobs, and passes axe', async () => {
    const world = new World()
    world.jobs = [
      job(),
      job({
        id: 'job_01M4S9000000000000000000J2',
        state: 'outcome_unknown',
        startedAt: null,
        finishedAt: '2026-10-13T10:00:00Z',
        outcome: null,
        resultVerified: null,
      }),
    ]
    // Ten hours left of a 72-hour certificate: it missed its renewal at 48 hours.
    world.status = nodeStatus({
      nodeCertificateExpiresAt: new Date(Date.now() + 10 * 3_600_000).toISOString(),
    })
    const { container } = mountApp(DETAIL, world)
    const status = await waitFor(() => {
      const found = document.getElementById('node-status')
      if (found?.textContent?.includes('postgres.roles.apply@2') !== true) throw new Error('wait')
      return found
    })
    expect(status.textContent).toContain('Reported by the agent')
    expect(status.textContent).toContain('17/main')
    expect(status.textContent).toContain('Expires soon')
    const jobs = await screen.findByRole('table', { name: 'Recent jobs' })
    const unknown = jobs.querySelector('[data-job="job_01M4S9000000000000000000J2"]')
    // What the store cannot know says so; it is never shown as a result.
    expect(unknown?.textContent).toContain('Not known')
    expect(unknown?.textContent).toContain('Not judged yet')
    expect(jobs.textContent).toContain('Verified')
    expect(await axeViolations(container)).toEqual([])
  })

  it('shows a failed job read as failed, never as "no jobs"', async () => {
    const world = new World()
    world.failures.set(`GET /api/v1/nodes/${NODE}/jobs`, {
      status: 500,
      code: 'INTERNAL',
      message: 'Boom.',
    })
    mountApp(DETAIL, world)
    expect(await screen.findByText('Could not read Job history')).toBeInTheDocument()
    expect(screen.queryByText('This node has run no job yet.')).toBeNull()
  })

  it('says what is missing when more jobs exist than one read returns', async () => {
    const world = new World()
    world.jobsNextCursor = 'next'
    mountApp(DETAIL, world)
    expect(await screen.findByText('Jobs before the newest 50')).toBeInTheDocument()
  })

  it('never shows an unknown node as green', async () => {
    const world = new World()
    world.status = nodeStatus({ state: 'unknown', lastHeartbeatAt: null, clockSkewMs: null })
    mountApp(DETAIL, world)
    const status = await waitFor(() => {
      const found = document.getElementById('node-status')?.querySelector('[data-node-state]')
      if (found == null) throw new Error('wait')
      return found
    })
    expect(status.querySelector('[data-health="healthy"]')).toBeNull()
    expect(status.querySelector('[data-health="unknown"]')).not.toBeNull()
    expect(screen.getByText('No heartbeat received')).toBeInTheDocument()
  })

  it('needs the node id typed before it plans a revocation, on the production frame', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.servers = [server({ derivedTier: 'prod' })]
    const { router, container } = mountApp(DETAIL, world)
    await user.click(await screen.findByRole('button', { name: 'Revoke node' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Plan the revocation of this node?',
    })
    await waitFor(() => expect(container.querySelector('[data-production-frame]')).not.toBeNull())
    const action = within(dialog).getByRole('button', { name: 'Plan revocation' })
    expect(action).toHaveAttribute('aria-disabled', 'true')
    await user.click(action)
    expect(world.changes).toEqual([])
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: NODE } })
    await waitFor(() => expect(action).not.toHaveAttribute('aria-disabled', 'true'))
    await user.click(action)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      { method: 'POST', path: `/api/v1/nodes/${NODE}/revoke`, body: {} },
    ])
  })

  it('plans a job key update and checks the key ids first', async () => {
    const user = userEvent.setup()
    const world = new World()
    const { router } = mountApp(DETAIL, world)
    const configForm = await waitFor(() => {
      const found = document.getElementById('node-config-form')
      if (found === null) throw new Error('no form')
      return found
    })
    const submit = within(configForm).getByRole('button', { name: 'Plan job key update' })
    fireEvent.change(within(configForm).getByLabelText('Keys to add'), {
      target: { value: 'Bad Key' },
    })
    await user.click(submit)
    expect(within(configForm).getByRole('alert')).toHaveTextContent(/A key ID is lowercase/)
    expect(world.changes).toEqual([])
    fireEvent.change(within(configForm).getByLabelText('Keys to add'), {
      target: { value: 'jk_2026_10' },
    })
    await user.click(submit)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes).toEqual([
      {
        method: 'POST',
        path: `/api/v1/nodes/${NODE}/config-updates`,
        body: { addJobKeys: ['jk_2026_10'], retireJobKeys: [] },
      },
    ])
  })

  it('offers no operation for a revoked node', async () => {
    const world = new World()
    world.status = nodeStatus({ state: 'revoked' })
    mountApp(DETAIL, world)
    expect(
      await screen.findByText('This node is no longer served; no operation is offered.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revoke node' })).toBeNull()
  })
})

describe('the enrollment token', () => {
  it('is revealed once with a fresh proof, kept out of every cache, and gone after leaving', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.enrollPlans = [enrollPlan()]
    world.needsProof = true
    const first = mountApp('/infrastructure/nodes', world)
    const item = await waitFor(() => {
      const found = document.querySelector(`[data-token="${TOKEN_ID}"]`)
      if (!(found instanceof HTMLElement)) throw new Error('no token item')
      return found
    })
    expect(within(item).getByRole('link', { name: SERVER })).toBeInTheDocument()
    await user.click(within(item).getByRole('button', { name: 'Reveal token' }))
    await confirmWithCode(user)

    const shown = await screen.findByRole('region', { name: 'Enrollment token' })
    expect(within(shown).getByText(TOKEN)).toBeInTheDocument()
    expect(shown.textContent).toContain('It is shown only this once')
    expect(shown.textContent).toContain('--token-file')
    expect(within(item).getByText('Revealed. It is not shown again.')).toBeInTheDocument()
    expect(world.changes.filter((s) => s.path.endsWith('/reveal'))).toHaveLength(2)
    // Never in the query or mutation cache, the address or browser storage.
    expect(cacheText(first.queryClient)).not.toContain(TOKEN)
    expect(first.router.state.location.pathname).not.toContain(TOKEN)
    expect(window.location.href).not.toContain(TOKEN)
    for (const store of [window.sessionStorage, window.localStorage]) {
      for (let i = 0; i < store.length; i++) {
        expect(store.getItem(store.key(i) ?? '') ?? '').not.toContain(TOKEN)
      }
    }
    expect(await axeViolations(first.container)).toEqual([])
    // Besides the one element: in no attribute (title, data-*, aria-*), comment, text or storage.
    expect(secretExposure(document.body, TOKEN, '#enrollment-token')).toEqual([])

    await user.click(within(shown).getByRole('button', { name: 'Hide token' }))
    expect(screen.queryByText(TOKEN)).toBeNull()
    expect(secretExposure(document.body, TOKEN, '#enrollment-token')).toEqual([])

    // A reload is a new page: the token is gone and the server does not reveal it again.
    first.unmount()
    mountApp('/infrastructure/nodes', world)
    const again = await waitFor(() => {
      const found = document.querySelector(`[data-token="${TOKEN_ID}"]`)
      if (!(found instanceof HTMLElement)) throw new Error('no token item')
      return found
    })
    expect(screen.queryByText(TOKEN)).toBeNull()
    await user.click(within(again).getByRole('button', { name: 'Reveal token' }))
    await waitFor(() =>
      expect(document.getElementById('node-enrollments')?.textContent).toContain('NOT_FOUND'),
    )
    expect(screen.queryByText(TOKEN)).toBeNull()
  })

  it('is gone after navigating away and back', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.enrollPlans = [enrollPlan()]
    const { router } = mountApp(`/infrastructure/servers/${SERVER}`, world)
    const item = await waitFor(() => {
      const found = document.querySelector(`[data-token="${TOKEN_ID}"]`)
      if (!(found instanceof HTMLElement)) throw new Error('no token item')
      return found
    })
    await user.click(within(item).getByRole('button', { name: 'Reveal token' }))
    expect(await screen.findByText(TOKEN)).toBeInTheDocument()
    await (router as unknown as { navigate: (o: { href: string }) => Promise<void> }).navigate({
      href: '/infrastructure/nodes',
    })
    await screen.findByRole('heading', { level: 1, name: 'Nodes' })
    expect(screen.queryByText(TOKEN)).toBeNull()
    await (router as unknown as { navigate: (o: { href: string }) => Promise<void> }).navigate({
      href: `/infrastructure/servers/${SERVER}`,
    })
    await screen.findByRole('heading', { level: 1, name: 'acme-db-01' })
    expect(screen.queryByText(TOKEN)).toBeNull()
  })

  it('shows a failed read of the enrollment plans as failed, not as "no tokens"', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/plans', { status: 500, code: 'INTERNAL', message: 'Boom.' })
    mountApp('/infrastructure/nodes', world)
    expect(await screen.findByText('Could not read Enrollment tokens')).toBeInTheDocument()
    expect(
      screen.queryByText('You have no applied enrollment plan whose token can be revealed.'),
    ).toBeNull()
  })
})
