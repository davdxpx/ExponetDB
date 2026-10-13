import '@testing-library/jest-dom/vitest'
import type { Readable } from '@exponetdb/ui-patterns'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { AppProviders } from '../../src/app/providers.tsx'
import { createReauthBridge } from '../../src/features/reauth/reauth.tsx'
import {
  ContentWrapper,
  type ContentWrapperProps,
} from '../../src/features/target/content-wrapper.tsx'
import type { Target, TargetHealth } from '../../src/features/target/queries.ts'
import { ApiClient } from '../../src/lib/api/client.ts'
import { createQueryClient } from '../../src/lib/query/client.ts'
import { RequireSession } from '../../src/lib/session/guard.tsx'
import { answer, NOW_ISO, type Permission, World } from './support.tsx'

afterEach(cleanup)

const PAGE = 'The page itself'

function target(over: Partial<Target> = {}): Target {
  return new World().add('shop/platform/staging', over)
}

function sample(over: Partial<TargetHealth> = {}): TargetHealth {
  const world = new World()
  world.add('shop/platform/staging')
  return world.sample('shop/platform/staging', over)
}

const ready = <T,>(value: T): Readable<T> => ({
  state: 'ready',
  value,
  source: 'live',
  observedAt: NOW_ISO(),
})

function node(state: NonNullable<TargetHealth['node']>['state']): TargetHealth['node'] {
  return { nodeId: 'nod_1', state, source: 'agent_reported', observedAt: NOW_ISO() }
}

/** Renders the wrapper inside the providers the app has, with a session that holds `permissions`. */
function show(
  props: Partial<ContentWrapperProps> & { readonly target: Readable<Target> },
  permissions: Permission[] = [],
) {
  const world = new World()
  world.permissions = permissions
  const client = new ApiClient({
    fetch: (async (input: string | URL | Request) => answer(world, input)) as typeof fetch,
    cookies: () => '__Host-exdb_csrf=t',
    onSessionGone: vi.fn(),
  })
  const ui: ReactElement = (
    <ContentWrapper requires={[]} {...props}>
      <p>{PAGE}</p>
    </ContentWrapper>
  )
  return render(
    <AppProviders
      services={{
        queryClient: createQueryClient(),
        client,
        reauth: createReauthBridge(),
        navigate: vi.fn(),
      }}
    >
      <RequireSession>{ui}</RequireSession>
    </AppProviders>,
  )
}

/** The wrapper without a session, for the states that read no permission. */
function showPlain(props: Partial<ContentWrapperProps> & { readonly target: Readable<Target> }) {
  const world = new World()
  const client = new ApiClient({
    fetch: (async (input: string | URL | Request) => answer(world, input)) as typeof fetch,
    cookies: () => '',
    onSessionGone: vi.fn(),
  })
  return render(
    <AppProviders
      services={{
        queryClient: createQueryClient(),
        client,
        reauth: createReauthBridge(),
        navigate: vi.fn(),
      }}
    >
      <ContentWrapper requires={[]} {...props}>
        <p>{PAGE}</p>
      </ContentWrapper>
    </AppProviders>,
  )
}

describe('ContentWrapper: the target read', () => {
  it('shows a loading region while the target is read, and not the page', () => {
    showPlain({ target: { state: 'loading' } })
    expect(screen.getByRole('status')).toHaveTextContent('Loading target')
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('shows a failed read with its code and a retry, never the page, an empty state or "not found"', async () => {
    const onRetry = vi.fn()
    showPlain({
      target: { state: 'failed', error: { code: 'INTERNAL_ERROR', message: 'It broke.' } },
      onRetry,
    })
    expect(
      screen.getByRole('heading', { level: 2, name: 'Could not read target' }),
    ).toBeInTheDocument()
    expect(screen.getByText('It broke.')).toBeInTheDocument()
    expect(screen.getByText('INTERNAL_ERROR')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no target.')).toBeInTheDocument()
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
    expect(screen.queryByText(/nothing to show/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/page not found/i)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps the value of a stale read under a banner with its age and a refresh', async () => {
    const onRetry = vi.fn()
    showPlain({
      target: {
        state: 'stale',
        value: target(),
        source: 'cached',
        observedAt: new Date(Date.now() - 5 * 60_000 - 5_000).toISOString(),
        error: { code: 'NETWORK', message: 'The server could not be reached.' },
      },
      onRetry,
    })
    expect(screen.getByText(PAGE)).toBeInTheDocument()
    expect(screen.getByText('Showing an earlier read of target')).toBeInTheDocument()
    expect(screen.getByText(/[45] min ago/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows the page for an active target with no requirement', () => {
    showPlain({ target: ready(target()) })
    expect(screen.getByText(PAGE)).toBeInTheDocument()
  })
})

describe('ContentWrapper: the lifecycle of the target', () => {
  it('names a decommissioned target and offers the list of databases', () => {
    showPlain({ target: ready(target({ state: 'decommissioned' })), requires: ['wave9'] })
    expect(
      screen.getByRole('heading', { level: 2, name: 'This target is decommissioned' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to databases' })).toHaveAttribute(
      'href',
      '/targets',
    )
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('names a suspended target before anything else the page needs', () => {
    showPlain({ target: ready(target({ state: 'suspended' })), requires: ['wave9', 'od21'] })
    expect(
      screen.getByRole('heading', { level: 2, name: 'This target is suspended' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the audit log' })).toHaveAttribute(
      'href',
      '/audit',
    )
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })
})

describe('ContentWrapper: pages that wait', () => {
  it('shows "not available yet" for a page of Wave 9, with the page name', () => {
    showPlain({ target: ready(target()), requires: ['wave9'], feature: 'Performance' })
    expect(
      screen.getByRole('heading', { level: 2, name: 'Performance is not available yet' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/arrives with Wave 9/)).toBeInTheDocument()
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('shows "not available yet" with the OD-21 copy for a page that waits for the decision', () => {
    showPlain({ target: ready(target()), requires: ['od21'], feature: 'Notifications' })
    expect(
      screen.getByRole('heading', { level: 2, name: 'Notifications is not available yet' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/OD-21/)).toBeInTheDocument()
  })
})

describe('ContentWrapper: permissions', () => {
  it('names the permission the person lacks instead of a broken page', async () => {
    show({ target: ready(target()), requires: ['permission:audit.read'] }, ['targets.read'])
    expect(
      await screen.findByRole('heading', { level: 2, name: 'You do not have access to this page' }),
    ).toBeInTheDocument()
    expect(screen.getByText('audit.read')).toBeInTheDocument()
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('shows the page when the person holds the permission', async () => {
    show({ target: ready(target()), requires: ['permission:audit.read'] }, ['audit.read'])
    expect(await screen.findByText(PAGE)).toBeInTheDocument()
  })
})

describe('ContentWrapper: target.reachable', () => {
  const requires = ['target.reachable'] as const

  it('says the target is unreachable, with the source and age of the sample', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unreachable', node: node('active') })),
      onRetryHealth: vi.fn(),
    })
    const state = screen.getByRole('region', { name: 'The target is unreachable' })
    expect(state).toHaveTextContent('Source: sampled. Observed just now')
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument()
  })

  it('says the database is the likely problem when the node agent is alive', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unreachable', node: node('active') })),
    })
    expect(screen.getByText(/node agent on its host is alive/)).toBeInTheDocument()
  })

  it('says it cannot tell the network from the host when the node is offline too', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unreachable', node: node('offline') })),
    })
    expect(
      screen.getByText(/cannot tell whether the network or the host failed/),
    ).toBeInTheDocument()
  })

  it('says it cannot see the host for a cluster without a node agent', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unreachable', node: null })),
    })
    expect(screen.getByText(/cannot see its host/)).toBeInTheDocument()
  })

  it('reads the health again from the next action', async () => {
    const onRetryHealth = vi.fn()
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unreachable' })),
      onRetryHealth,
    })
    await userEvent.click(screen.getByRole('button', { name: 'Read health again' }))
    expect(onRetryHealth).toHaveBeenCalledTimes(1)
  })

  it('cannot tell when health is unknown, and gives the reason in words', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unknown', unknownBecause: 'control_plane_degraded' })),
    })
    const state = screen.getByRole('region', {
      name: 'Cannot tell whether the target is reachable',
    })
    expect(state).toHaveTextContent("ExponetDB's own sampler is not running.")
    expect(state).toHaveTextContent('The database may be fine.')
    expect(state).toHaveTextContent('Source: sampled. Observed')
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('shows a reason code it does not know as the code it is', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unknown', unknownBecause: 'quantum_flux' })),
    })
    expect(screen.getByText('The reason code is quantum_flux.')).toBeInTheDocument()
  })

  it('does not look up a reason in the prototype chain', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ state: 'unknown', unknownBecause: 'constructor' })),
    })
    expect(screen.getByText('The reason code is constructor.')).toBeInTheDocument()
  })

  it('cannot tell when the health read failed: neither healthy, nor unreachable, nor the page', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: { state: 'failed', error: { code: 'INTERNAL_ERROR', message: 'It broke.' } },
    })
    const state = screen.getByRole('region', {
      name: 'Cannot tell whether the target is reachable',
    })
    expect(state).toHaveTextContent('Could not read the health of this target')
    expect(state).toHaveTextContent('It broke. (INTERNAL_ERROR)')
    expect(state).toHaveTextContent('This does not mean it is unreachable.')
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
    expect(screen.queryByText(/healthy/i)).not.toBeInTheDocument()
  })

  it('cannot tell when the page passes no health read (it fails closed)', () => {
    showPlain({ target: ready(target()), requires })
    expect(
      screen.getByRole('region', { name: 'Cannot tell whether the target is reachable' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('shows a loading region while health is read', () => {
    showPlain({ target: ready(target()), requires, health: { state: 'loading' } })
    expect(screen.getByRole('status')).toHaveTextContent('Loading target health')
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('shows the page for a reachable target', () => {
    showPlain({ target: ready(target()), requires, health: ready(sample({ state: 'degraded' })) })
    expect(screen.getByText(PAGE)).toBeInTheDocument()
  })

  it('shows the page under a stale banner when the health sample is old and does not say unreachable', async () => {
    const onRetryHealth = vi.fn()
    showPlain({
      target: ready(target()),
      requires,
      health: {
        state: 'stale',
        value: sample({ state: 'healthy' }),
        source: 'cached',
        observedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
      onRetryHealth,
    })
    expect(screen.getByText(PAGE)).toBeInTheDocument()
    expect(screen.getByText('Showing an earlier read of target health')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRetryHealth).toHaveBeenCalledTimes(1)
  })
})

describe('ContentWrapper: node.online', () => {
  const requires = ['node.online'] as const

  it('says the node is not online, with what it reports', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ node: node('pending_enrollment') })),
    })
    const state = screen.getByRole('region', { name: 'The node is not online' })
    expect(state).toHaveTextContent('reports pending enrollment')
    expect(state).toHaveTextContent('Source: reported by agent. Observed')
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('cannot tell when the node state is unknown', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ node: node('unknown') })),
    })
    expect(
      screen.getByRole('region', { name: 'Cannot tell whether the node is online' }),
    ).toBeInTheDocument()
  })

  it('cannot tell when the health read failed', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: { state: 'failed', error: { code: 'INTERNAL_ERROR', message: 'It broke.' } },
    })
    const state = screen.getByRole('region', { name: 'Cannot tell whether the node is online' })
    expect(state).toHaveTextContent('This does not mean the node is offline.')
  })

  it('says the page is not supported for a cluster without a node agent', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ node: null })),
      feature: 'Packages',
    })
    expect(
      screen.getByRole('heading', { level: 2, name: 'Not supported on this target' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Packages needs a node agent on the cluster. The cluster of this target is managed outside ExponetDB and has none.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(PAGE)).not.toBeInTheDocument()
  })

  it('shows the page for an online node', () => {
    showPlain({
      target: ready(target()),
      requires,
      health: ready(sample({ node: node('active') })),
    })
    expect(screen.getByText(PAGE)).toBeInTheDocument()
  })
})

describe('ContentWrapper: accessibility', () => {
  const cases: readonly [string, Partial<ContentWrapperProps> & { target: Readable<Target> }][] = [
    ['loading', { target: { state: 'loading' } }],
    [
      'failed',
      {
        target: { state: 'failed', error: { code: 'X', message: 'It broke.' } },
        onRetry: () => undefined,
      },
    ],
    [
      'decommissioned',
      { target: ready(target({ state: 'decommissioned' })), requires: ['target.reachable'] },
    ],
    [
      'suspended',
      { target: ready(target({ state: 'suspended' })), requires: ['target.reachable'] },
    ],
    ['wave9', { target: ready(target()), requires: ['wave9'] }],
    ['od21', { target: ready(target()), requires: ['od21'] }],
    [
      'unreachable',
      {
        target: ready(target()),
        requires: ['target.reachable'],
        health: ready(sample({ state: 'unreachable', node: node('offline') })),
        onRetryHealth: () => undefined,
      },
    ],
    [
      'cannot tell',
      {
        target: ready(target()),
        requires: ['target.reachable'],
        health: ready(sample({ state: 'unknown', unknownBecause: 'never_sampled' })),
      },
    ],
    [
      'node offline',
      {
        target: ready(target()),
        requires: ['node.online'],
        health: ready(sample({ node: node('offline') })),
      },
    ],
  ]

  it.each(['suspended', 'decommissioned'] as const)(
    'shows a page of stored data on a %s target under a notice, with no axe violations',
    async (state) => {
      const view = showPlain({ target: ready(target({ state })), requires: [] })
      expect(within(view.container).getByText(PAGE)).toBeInTheDocument()
      expect(within(view.container).getByText(`This target is ${state}`)).toBeInTheDocument()
      expect(await axeViolations(view.container)).toEqual([])
    },
  )

  it.each(cases)('has no axe violations in the %s state', async (_name, props) => {
    const view = showPlain(props)
    expect(await axeViolations(view.container)).toEqual([])
    expect(within(view.container).queryByText(PAGE)).not.toBeInTheDocument()
  })
})
