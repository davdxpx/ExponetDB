import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { settingsKeys } from '../../src/features/settings/keys.ts'
import { breakGlass, breakGlassList, chain, dataReadRule, event } from '../admin/fixtures.ts'
import { mountApp, problem, T0, World } from '../admin/support.tsx'

/**
 * Stale and partial reads of the audit and settings screens (C-28). A stale read is made the
 * way it happens: the page read successfully, then the next read fails and the cache refetches.
 */

afterEach(cleanup)

const PRODUCT = 'prd_01JZ0000000000000000000001'
const BOOM = () => problem(500, 'INTERNAL', 'The server failed.')

type Client = ReturnType<typeof mountApp>['queryClient']

async function refetchFailing(
  world: World,
  queryClient: Client,
  failing: readonly string[],
  queryKey: readonly unknown[],
): Promise<void> {
  for (const path of failing) world.on('GET', path, BOOM)
  await act(async () => {
    await queryClient.refetchQueries({ queryKey })
  })
}

/** The stale banner naming `what`: its age is shown and it holds a Refresh button. */
async function expectStaleBanner(what: string): Promise<void> {
  const title = await screen.findByText(`Showing an earlier read of ${what}`)
  const banner = title.closest<HTMLElement>('[data-state="stale"]')
  expect(banner).not.toBeNull()
  expect(banner?.textContent).toMatch(/Observed/)
  expect(within(banner as HTMLElement).getByRole('button', { name: 'Refresh' })).toBeInTheDocument()
}

function auditWorld(): World {
  const world = new World()
  world.on(
    'GET',
    '/api/v1/audit-events/chain',
    chain({
      anchorCheckpointSeq: 100,
      fromSeq: 100,
      scope: 'from_checkpoint',
      status: 'verified',
      throughSeq: 120,
      verifiedAt: T0,
      verifiedEvents: 21,
    }),
  )
  world.on('GET', '/api/v1/audit-events', { items: [event()], nextCursor: null })
  return world
}

describe('the audit screens', () => {
  it('shows an old audit event search as stale with its age and a refresh', async () => {
    const world = auditWorld()
    const { queryClient } = mountApp('/audit', world)
    await waitFor(() => expect(document.querySelector('[data-event]')).not.toBeNull())
    await refetchFailing(world, queryClient, ['/api/v1/audit-events'], ['audit', 'events'])
    await expectStaleBanner('Audit events')
    expect(document.querySelector('[data-event]')).not.toBeNull()
  })

  it('says a partial audit event search has more events and is not the whole log', async () => {
    const world = auditWorld()
    world.on('GET', '/api/v1/audit-events', { items: [event()], nextCursor: 'older' })
    mountApp('/audit', world)
    expect(
      await screen.findByText('1 events are shown. Older events match too.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show older events' })).toBeInTheDocument()
    expect(screen.queryByText(/^All \d+ matching events are shown/)).toBeNull()
  })
})

describe('the settings screens', () => {
  it('shows an old break-glass grant list as stale with its age and a refresh', async () => {
    const world = new World()
    world.on('GET', '/api/v1/break-glass-grants', breakGlassList([breakGlass()]))
    world.on('GET', '/api/v1/products', { items: [], nextCursor: null })
    const { queryClient } = mountApp('/settings/break-glass', world)
    await waitFor(() => expect(document.querySelector('li[data-grant]')).not.toBeNull())
    await refetchFailing(
      world,
      queryClient,
      ['/api/v1/break-glass-grants'],
      settingsKeys.breakGlass('all'),
    )
    await expectStaleBanner('Break-glass grants')
    expect(document.querySelector('li[data-grant]')).not.toBeNull()
  })

  it('says a partial break-glass grant list is partial, never complete or empty', async () => {
    const world = new World()
    world.on('GET', '/api/v1/break-glass-grants', {
      ...breakGlassList([breakGlass()]),
      nextCursor: 'more',
    })
    world.on('GET', '/api/v1/products', { items: [], nextCursor: null })
    mountApp('/settings/break-glass', world)
    expect(await screen.findByText('Showing part of Break-glass grants')).toBeInTheDocument()
    expect(screen.queryByText('No break-glass grants')).toBeNull()
  })

  it('shows old products and environments as stale with their age and a refresh', async () => {
    const world = new World()
    world.on('GET', '/api/v1/break-glass-grants', breakGlassList([]))
    const products = {
      items: [{ id: PRODUCT, slug: 'shop', displayName: 'Shop' }],
      nextCursor: null,
    }
    world.on('GET', '/api/v1/products', products)
    world.on('GET', `/api/v1/products/${PRODUCT}/environments`, { items: [], nextCursor: null })
    const first = mountApp('/settings/products', world)
    await screen.findByText('Shop')
    await refetchFailing(world, first.queryClient, ['/api/v1/products'], settingsKeys.products)
    await expectStaleBanner('Product list')
    expect(screen.getByText('Shop')).toBeInTheDocument()
    cleanup()

    world.on('GET', '/api/v1/products', products)
    const second = mountApp('/settings/environments', world)
    await waitFor(() =>
      expect(document.querySelector(`[data-product="${PRODUCT}"]`)).not.toBeNull(),
    )
    await refetchFailing(
      world,
      second.queryClient,
      [`/api/v1/products/${PRODUCT}/environments`],
      settingsKeys.environments(PRODUCT),
    )
    await expectStaleBanner('Environment list')
  })

  it('shows an old policy read as stale with its age and a refresh', async () => {
    const world = new World()
    world.on('GET', '/api/v1/break-glass-grants', breakGlassList([]))
    world.on('GET', '/api/v1/policy-settings', { rules: [dataReadRule({ settings: [] })] })
    world.on('GET', '/api/v1/targets', { items: [], nextCursor: null })
    const { queryClient } = mountApp('/settings/policies', world)
    await waitFor(() => expect(queryClient.getQueryData(settingsKeys.policies)).toBeDefined())
    await refetchFailing(world, queryClient, ['/api/v1/policy-settings'], settingsKeys.policies)
    await expectStaleBanner('Policy settings')
  })

  it('shows an old installation and health read as stale with their age and a refresh', async () => {
    const world = new World()
    world.on('GET', '/api/v1/break-glass-grants', breakGlassList([]))
    world.on('GET', '/api/v1/installation', {
      contracts: {
        mcpCatalog: 'exponetdb.mcp/v1',
        migrationManifest: 'exponetdb.migration/v1',
        nodeProtocol: 'exponetdb.node/v1',
        projectConfig: 'exponetdb.project/v1',
        restApi: 'v1',
      },
      features: ['registry'],
      installationId: 'ins_01JZ0000000000000000000001',
      version: '0.8.0',
    })
    world.on('GET', '/api/v1/installation/health', {
      components: [
        {
          component: 'control_store',
          observedAt: new Date().toISOString(),
          source: 'live',
          state: 'operational',
        },
      ],
      observedAt: new Date().toISOString(),
      state: 'operational',
      unobserved: [],
    })
    const { queryClient } = mountApp('/settings/installation', world)
    await screen.findByText('0.8.0')
    await waitFor(() => expect(queryClient.getQueryData(settingsKeys.health)).toBeDefined())
    await refetchFailing(
      world,
      queryClient,
      ['/api/v1/installation', '/api/v1/installation/health'],
      settingsKeys.installation,
    )
    await expectStaleBanner('Installation details')
    await expectStaleBanner('Control Plane health')
  })
})
