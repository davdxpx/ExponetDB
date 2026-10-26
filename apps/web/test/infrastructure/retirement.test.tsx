import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { infraKeys } from '../../src/features/infrastructure/keys.ts'
import { BIDI, CLUSTER, cluster, mountApp, NODE, PLAN, SERVER, server, World } from './support.tsx'

afterEach(cleanup)

const OP = 'op_01M4S9000000000000000000Q9'

function preflight(over: Record<string, unknown> = {}) {
  return {
    subject: { kind: 'server', id: SERVER, state: 'active' },
    verdict: 'blocked',
    blockers: [
      {
        kind: 'cluster',
        total: 3,
        items: [
          { kind: 'cluster', id: CLUSTER, state: 'active', label: `main${BIDI}`, targetId: null },
        ],
      },
      {
        kind: 'node',
        total: 1,
        items: [{ kind: 'node', id: NODE, state: 'revoked', label: null, targetId: null }],
      },
      {
        kind: 'operation',
        total: 1,
        items: [
          {
            kind: 'operation',
            id: OP,
            state: 'running',
            label: 'postgres.restart',
            targetId: null,
          },
        ],
      },
    ],
    retiredWith: [],
    kept: { retiredChildren: 2 },
    providers: [{ provider: 'backups', state: 'not_installed' }],
    source: 'live',
    observedAt: new Date().toISOString(),
    ...over,
  }
}

async function section(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: 'Remove from ExponetDB' })
  return heading.closest('[id$="-retire"]') as HTMLElement
}

describe('removing a server from ExponetDB', () => {
  it('lists what blocks it bottom-up, each blocker linked to where it is resolved, and offers no plan yet', async () => {
    const world = new World()
    world.retirements.set(`server:${SERVER}`, preflight())
    mountApp(`/infrastructure/servers/${SERVER}`, world)
    const root = await section()
    expect(await within(root).findByText('Before it can be removed')).toBeVisible()
    const groups = [...root.querySelectorAll('[data-blocker]')].map((g) =>
      g.getAttribute('data-blocker'),
    )
    // Bottom-up: an open operation first, then the clusters, then the nodes.
    expect(groups).toEqual(['operation', 'cluster', 'node'])
    expect(within(root).getByText('3 clusters on this server are not retired')).toBeVisible()
    expect(within(root).getByText('And 2 more not listed here.')).toBeVisible()
    const clusterLink = within(root).getByRole('link', { name: /main/ })
    expect(clusterLink).toHaveAttribute('href', `/infrastructure/clusters/${CLUSTER}`)
    expect(clusterLink.textContent).toContain('⟨U+202E⟩')
    expect(within(root).getByRole('link', { name: NODE })).toHaveAttribute(
      'href',
      `/infrastructure/nodes/${NODE}`,
    )
    expect(within(root).getByRole('link', { name: 'postgres.restart' })).toHaveAttribute(
      'href',
      `/changes/operations/${OP}`,
    )
    expect(within(root).getByText(/A revoked node still blocks/)).toBeVisible()
    // What removal never does is said before anything else.
    expect(root.textContent).toMatch(/Does not delete or stop the machine/)
    expect(root.textContent).toMatch(/no backup engine records anything yet/)
    const action = within(root).getByRole('button', { name: 'Plan removal of this server' })
    expect(action).toBeDisabled()
    expect(action).toHaveAccessibleDescription('Resolve the items above first.')
    expect(world.changes).toHaveLength(0)
  })

  it('asks for the removal plan after the confirmation and opens its review page', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.retirements.set(`server:${SERVER}`, preflight({ verdict: 'can_plan', blockers: [] }))
    const { router } = mountApp(`/infrastructure/servers/${SERVER}`, world)
    const root = await section()
    expect(await within(root).findByText(/Nothing blocks the removal now/)).toBeVisible()
    await user.click(within(root).getByRole('button', { name: 'Plan removal of this server' }))
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Plan the removal of this server?',
    })
    const create = within(dialog).getByRole('button', { name: 'Create plan' })
    // Both statements must be ticked: retired for good, nothing deleted on the machine.
    expect(create).toHaveAttribute('aria-disabled', 'true')
    for (const box of within(dialog).getAllByRole('checkbox')) await user.click(box)
    await user.type(within(dialog).getByRole('textbox'), 'host_returned')
    await user.click(create)
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', `/api/v1/servers/${SERVER}/retire`, { reason: 'host_returned' }],
    ])
  })

  it('says a retired server was removed, shows no enrollment and offers nothing (none)', async () => {
    const world = new World()
    world.servers = [server({ state: 'retired', retiredAt: new Date().toISOString() })]
    mountApp(`/infrastructure/servers/${SERVER}`, world)
    const root = await section()
    expect(await within(root).findByText(/This server was removed from ExponetDB/)).toBeVisible()
    expect(within(root).queryByRole('button')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Enroll a node' })).toBeNull()
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Retired')
    expect(world.sent.some((s) => s.path.endsWith('/retirement'))).toBe(false)
  })

  it('reads nothing and says blockers may exist without registry.manage', async () => {
    const world = new World()
    world.permissions = []
    mountApp(`/infrastructure/servers/${SERVER}`, world)
    const root = await section()
    expect(within(root).getByText('Removal needs registry administration')).toBeVisible()
    expect(world.sent.some((s) => s.path.endsWith('/retirement'))).toBe(false)
  })

  it('shows a failed read as failed, never as nothing to resolve', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/servers/', { status: 500, code: 'INTERNAL', message: 'No.' })
    world.servers = [server()]
    world.failures.clear()
    world.failures.set('/retirement', {
      status: 500,
      code: 'INTERNAL',
      message: 'The store is down.',
    })
    mountApp(`/infrastructure/servers/${SERVER}`, world)
    const root = await section()
    expect(await within(root).findByText('The store is down.')).toBeVisible()
    expect(within(root).queryByText(/Nothing blocks the removal/)).toBeNull()
    expect(within(root).queryByRole('button', { name: /Plan removal/ })).toBeNull()
  })

  it('keeps an earlier read as stale (old) with its age when a refresh fails', async () => {
    const world = new World()
    world.retirements.set(`server:${SERVER}`, preflight())
    const { queryClient } = mountApp(`/infrastructure/servers/${SERVER}`, world)
    const root = await section()
    await within(root).findByText('Before it can be removed')
    world.failures.set('/retirement', { status: 500, code: 'INTERNAL', message: 'Down.' })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: infraKeys.retirement('server', SERVER) })
    })
    await waitFor(() => expect(root.querySelector('[data-state="stale"]')).not.toBeNull())
    expect(within(root).getByText('Before it can be removed')).toBeVisible()
  })

  it('has no accessibility violations', async () => {
    const world = new World()
    world.retirements.set(`server:${SERVER}`, preflight())
    const { container } = mountApp(`/infrastructure/servers/${SERVER}`, world)
    await within(await section()).findByText('Before it can be removed')
    expect(await axeViolations(container)).toEqual([])
  })
})

describe('removing a cluster from ExponetDB', () => {
  it('names the endpoints and credentials retired with it, and plans the removal', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.clusters = [cluster({ declaredTier: 'nonprod', derivedTier: 'nonprod' })]
    world.retirements.set(`cluster:${CLUSTER}`, {
      ...preflight({ verdict: 'can_plan', blockers: [] }),
      subject: { kind: 'cluster', id: CLUSTER, state: 'active' },
      retiredWith: [
        { kind: 'endpoint', total: 2, items: [] },
        { kind: 'credential', total: 3, items: [] },
      ],
    })
    const { router } = mountApp(`/infrastructure/clusters/${CLUSTER}`, world)
    const root = await section()
    expect(await within(root).findByText('Retired with it, in the same operation')).toBeVisible()
    expect(within(root).getByText('2 active endpoints')).toBeVisible()
    expect(
      within(root).getByText(/3 active credentials \(their secrets are not erased\)/),
    ).toBeVisible()
    await user.click(within(root).getByRole('button', { name: 'Plan removal of this cluster' }))
    const dialog = await screen.findByRole('alertdialog')
    for (const box of within(dialog).getAllByRole('checkbox')) await user.click(box)
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes.map((c) => c.path)).toEqual([`/api/v1/clusters/${CLUSTER}/retire`])
  })

  it('links a registered database to its row and offers "Retire record" on an unplaced one', async () => {
    const user = userEvent.setup()
    const world = new World()
    world.databases = [
      {
        id: 'dbs_01M4S9000000000000000000D1',
        clusterId: CLUSTER,
        name: 'orders',
        state: 'registered',
        createdAt: new Date().toISOString(),
        observed: null,
        placement: null,
      },
    ] as World['databases']
    world.retirements.set(`cluster:${CLUSTER}`, {
      ...preflight({
        blockers: [
          {
            kind: 'database',
            total: 1,
            items: [
              {
                kind: 'database',
                id: 'dbs_01M4S9000000000000000000D1',
                state: 'registered',
                label: 'orders',
                targetId: null,
              },
            ],
          },
        ],
      }),
      subject: { kind: 'cluster', id: CLUSTER, state: 'active' },
    })
    const { router } = mountApp(`/infrastructure/clusters/${CLUSTER}`, world)
    const root = await section()
    expect(await within(root).findByRole('link', { name: 'orders' })).toHaveAttribute(
      'href',
      `/infrastructure/clusters/${CLUSTER}#cluster-placements`,
    )
    await user.click(
      await screen.findByRole('button', { name: 'Retire the record of database orders' }),
    )
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Plan retiring this database record?',
    })
    expect(dialog.textContent).toMatch(/not dropped or changed/)
    for (const box of within(dialog).getAllByRole('checkbox')) await user.click(box)
    await user.click(within(dialog).getByRole('button', { name: 'Create plan' }))
    await waitFor(() => expect(router.state.location.pathname).toBe(`/changes/plans/${PLAN}`))
    expect(world.changes.map((c) => c.path)).toEqual([
      `/api/v1/clusters/${CLUSTER}/databases/dbs_01M4S9000000000000000000D1/retire`,
    ])
  })

  it('says how many of a group are not named when its list is cut (partial, truncated)', async () => {
    const world = new World()
    world.retirements.set(`cluster:${CLUSTER}`, {
      ...preflight({
        blockers: [{ kind: 'database', total: 120, items: [] }],
      }),
      subject: { kind: 'cluster', id: CLUSTER, state: 'active' },
    })
    mountApp(`/infrastructure/clusters/${CLUSTER}`, world)
    const root = await section()
    expect(
      await within(root).findByText('120 databases are registered on this cluster'),
    ).toBeVisible()
    expect(within(root).getByText('And 120 more not listed here.')).toBeVisible()
  })
})
