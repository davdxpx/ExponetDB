import '@testing-library/jest-dom/vitest'
import { cleanup, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  minutesAgo,
  mountApp,
  NODE_ID,
  nodeFixture,
  placementFixture,
  project,
  World,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const STAGING = 'shop/platform/staging'
const OVERVIEW = '/t/shop/platform/staging'

/** A target on an agent-managed cluster whose health sample names the node. */
function agentWorld(): World {
  const world = new World()
  project(world)
  world.update(STAGING, { placement: placementFixture('agent') })
  world.sample(STAGING, {
    node: {
      nodeId: NODE_ID,
      state: 'active',
      source: 'agent_reported',
      observedAt: new Date().toISOString(),
    },
  })
  world.nodes.set(NODE_ID, nodeFixture())
  return world
}

async function host(): Promise<HTMLElement> {
  const facts = await waitFor(() => {
    const el = document.querySelector('[data-block="facts"]')
    if (el === null) throw new Error('no facts block')
    return el as HTMLElement
  })
  const label = await within(facts).findByText('Host')
  return label.closest('div') as HTMLElement
}

const nodeReads = (world: World): number =>
  world.requests.filter((request) => request.startsWith('/api/v1/nodes/')).length

describe('the host row of an agent-managed placement', () => {
  it('shows the load, the memory and the disk the node agent reports, with the source and the age', async () => {
    mountApp(OVERVIEW, agentWorld())
    const row = await host()
    await waitFor(() =>
      expect(row).toHaveTextContent(
        'Load 0.42 (1 min), 3.1 GiB of memory used, 61 % of the disk used',
      ),
    )
    expect(row).toHaveTextContent('Reported by agent')
    expect(row).toHaveTextContent(/Reported by the node agent (just now|\d+ s ago)/)
    // A memory figure is in bytes in the contract: it is shown as a size, not as a percentage.
    expect(row).not.toHaveTextContent(/\d+ % of (the )?memory/)
  })

  it('says not reported for an external cluster, as a fact of the placement, and asks no node', async () => {
    const world = agentWorld()
    world.update(STAGING, { placement: placementFixture('external') })
    world.sample(STAGING, { node: null })
    mountApp(OVERVIEW, world)
    const row = await host()
    expect(row).toHaveTextContent(
      'Not reported. This cluster is external: no node agent reports its host.',
    )
    expect(row.querySelector('[role="alert"]')).toBeNull()
    expect(row).not.toHaveTextContent('Could not read')
    expect(nodeReads(world)).toBe(0)
  })

  it('shows no host row for a target without a placement', async () => {
    const world = agentWorld()
    world.update(STAGING, { placement: null })
    mountApp(OVERVIEW, world)
    const facts = await waitFor(() => {
      const el = document.querySelector('[data-block="facts"]')
      if (el === null) throw new Error('no facts block')
      return el as HTMLElement
    })
    await within(facts).findByText('No placement is recorded for this target.')
    expect(within(facts).queryByText('Host')).toBeNull()
    expect(nodeReads(world)).toBe(0)
  })

  it('says no node is bound when the health sample names none for an agent placement', async () => {
    const world = agentWorld()
    world.sample(STAGING, { node: null })
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() =>
      expect(row).toHaveTextContent('Not reported. No node agent is bound to this cluster.'),
    )
    expect(nodeReads(world)).toBe(0)
  })

  it('says the node is not located, and that the host may be fine or not, when the health read failed', async () => {
    const world = agentWorld()
    world.failuresExact.set('/api/v1/targets/shop%2Fplatform%2Fstaging/health', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The sampler store did not answer.',
    })
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('Not located.'))
    expect(row).toHaveTextContent('The sampler store did not answer. (INTERNAL_ERROR)')
    expect(row).toHaveTextContent('This does not mean the host is fine.')
    expect(row).not.toHaveTextContent('Load')
    expect(nodeReads(world)).toBe(0)
  })

  it('shows a failed node read as failed with its code, never as zero values', async () => {
    const world = agentWorld()
    world.failures.set('/nodes/', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The node store did not answer.',
    })
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('Could not read host values'))
    expect(row).toHaveTextContent('The node store did not answer.')
    expect(row).toHaveTextContent('INTERNAL_ERROR')
    expect(row).toHaveTextContent('This does not mean there is no host values.')
    expect(row).not.toHaveTextContent(/Load 0/)
    expect(row).not.toHaveTextContent('0 %')
  })

  it('shows an old node read as stale with its age and a refresh', async () => {
    const world = agentWorld()
    world.nodes.set(
      NODE_ID,
      nodeFixture({ observedAt: minutesAgo(30), lastHeartbeatAt: minutesAgo(30) }),
    )
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('Showing an earlier read of host values'))
    expect(row).toHaveTextContent('Load 0.42')
    expect(within(row).getByRole('button', { name: /Refresh/ })).toBeInTheDocument()
    expect(row).toHaveTextContent(/Reported by the node agent (29|30) min ago/)
  })

  it('says not reported when the node agent has sent no host values, and no zero for them', async () => {
    const world = agentWorld()
    world.nodes.set(NODE_ID, nodeFixture({ host: null, source: 'inferred' }))
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() =>
      expect(row).toHaveTextContent('Not reported. The node agent has sent no host values.'),
    )
    expect(row).not.toHaveTextContent('Load')
    expect(row).toHaveTextContent('Inferred')
    expect(row).toHaveTextContent(/Node status read/)
  })

  it('names the permission when the node read was refused', async () => {
    const world = agentWorld()
    world.failures.set('/nodes/', {
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'nodes.read is missing.',
    })
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('You do not have access to host values'))
    expect(row).toHaveTextContent('nodes.read')
    expect(row).not.toHaveTextContent('Load')
  })

  it('shows the state of a node that is not active beside the values', async () => {
    const world = agentWorld()
    world.nodes.set(NODE_ID, nodeFixture({ state: 'offline' }))
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('Node state: offline.'))
    expect(row).toHaveTextContent('Load 0.42')
  })

  it('shows the severity the server gave the disk and judges no percentage itself', async () => {
    const world = agentWorld()
    world.nodes.set(
      NODE_ID,
      nodeFixture({ host: { loadAverage1m: 3, memoryUsedBytes: 1024 ** 3, diskUsedPercent: 99 } }),
    )
    mountApp(OVERVIEW, world)
    const quiet = await host()
    await waitFor(() => expect(quiet).toHaveTextContent('99 % of the disk used'))
    // 99 % with no condition from the server: no word of judgement.
    expect(quiet).not.toHaveTextContent('Server condition')
    cleanup()
    const flagged = agentWorld()
    flagged.nodes.set(
      NODE_ID,
      nodeFixture({ host: { loadAverage1m: 3, memoryUsedBytes: 1024 ** 3, diskUsedPercent: 81 } }),
    )
    flagged.sample(STAGING, {
      node: {
        nodeId: NODE_ID,
        state: 'active',
        source: 'agent_reported',
        observedAt: new Date().toISOString(),
      },
      conditions: [
        {
          condition: 'disk_high',
          severity: 'warning',
          count: null,
          observedAt: new Date().toISOString(),
        },
      ],
    })
    mountApp(OVERVIEW, flagged)
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('Server condition for the disk: Warning.'))
  })

  it('is loading while the node read is out', async () => {
    const world = agentWorld()
    let release: () => void = () => {}
    world.delays.set(
      '/nodes/',
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp(OVERVIEW, world)
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('Loading host values'))
    expect(row).not.toHaveTextContent('Load 0')
    release()
    await waitFor(() => expect(row).toHaveTextContent('Load 0.42'))
  })

  it('has no accessibility violations in its states', async () => {
    mountApp(OVERVIEW, agentWorld())
    const row = await host()
    await waitFor(() => expect(row).toHaveTextContent('Load 0.42'))
    expect(await axeViolations(document.body)).toEqual([])
    cleanup()
    const failed = agentWorld()
    failed.failures.set('/nodes/', { status: 500, code: 'INTERNAL_ERROR' })
    mountApp(OVERVIEW, failed)
    const failedRow = await host()
    await waitFor(() => expect(failedRow).toHaveTextContent('Could not read host values'))
    expect(await axeViolations(document.body)).toEqual([])
  })
})
