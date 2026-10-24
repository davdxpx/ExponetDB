import '@testing-library/jest-dom/vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { minutesAgo, mountApp, project, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const STAGING = 'shop/platform/staging'
const OVERVIEW = '/t/shop/platform/staging'

function capacity(over: Record<string, unknown> = {}) {
  return {
    clientBackends: 37,
    usableSlots: 97,
    source: 'sampled',
    observedAt: minutesAgo(2.5),
    ...over,
  }
}

function worldWith(sample: Record<string, unknown> = {}): World {
  const world = new World()
  project(world)
  world.sample(STAGING, sample)
  return world
}

async function slots(): Promise<HTMLElement> {
  const facts = await waitFor(() => {
    const el = document.querySelector('[data-block="facts"]')
    if (el === null) throw new Error('no facts block')
    return el as HTMLElement
  })
  return waitFor(() => {
    const label = Array.from(facts.querySelectorAll('dt')).find(
      (el) => el.textContent === 'Connection slots',
    )
    if (label === undefined) throw new Error('no connection slots row')
    return label.closest('div') as HTMLElement
  })
}

describe('the connection slots row of the target facts', () => {
  it('shows N of M connection slots used from the sample, with its source and age', async () => {
    mountApp(OVERVIEW, worldWith({ capacity: capacity() }))
    const row = await slots()
    await waitFor(() => expect(row).toHaveTextContent('37 of 97 connection slots used'))
    expect(row).toHaveTextContent('Sampled')
    expect(row).toHaveTextContent('Measured 2 min ago')
    // The page compares nothing with a limit: no color and no verdict beside the numbers.
    expect(row.querySelector('[data-severity]')).toBeNull()
  })

  it('shows a measured zero as zero', async () => {
    mountApp(OVERVIEW, worldWith({ capacity: capacity({ clientBackends: 0 }) }))
    const row = await slots()
    await waitFor(() => expect(row).toHaveTextContent('0 of 97 connection slots used'))
  })

  it('says not reported, never zero, when the sample carries no capacity', async () => {
    mountApp(OVERVIEW, worldWith())
    const row = await slots()
    await waitFor(() => expect(row).toHaveTextContent('Not reported:'))
    expect(row).toHaveTextContent('did not measure the slots')
    expect(row).toHaveTextContent('This is not a count of zero.')
    expect(row).not.toHaveTextContent('connection slots used')
    expect(row).not.toHaveTextContent('0 of')
  })

  it('says it is not known, and not zero, when the health read failed', async () => {
    const world = worldWith({ capacity: capacity() })
    world.failuresExact.set('/api/v1/targets/shop%2Fplatform%2Fstaging/health', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The sampler store did not answer.',
    })
    mountApp(OVERVIEW, world)
    const row = await slots()
    await waitFor(() => expect(row).toHaveTextContent('The health read failed ('))
    expect(row).toHaveTextContent('The sampler store did not answer. (INTERNAL_ERROR)')
    expect(row).toHaveTextContent('This is not a count of zero.')
    expect(row).not.toHaveTextContent('connection slots used')
  })

  it('shows an old health read as the earlier one, keeping the figure and the age of its measurement', async () => {
    mountApp(
      OVERVIEW,
      worldWith({
        observedAt: minutesAgo(10),
        capacity: capacity({ observedAt: minutesAgo(10.5) }),
      }),
    )
    const row = await slots()
    await waitFor(() => expect(row).toHaveTextContent('37 of 97 connection slots used'))
    expect(row).toHaveTextContent('Measured 10 min ago')
  })

  it('names no source it has no word for', async () => {
    mountApp(OVERVIEW, worldWith({ capacity: capacity({ source: 'quantum' }) }))
    const row = await slots()
    await waitFor(() => expect(row).toHaveTextContent('37 of 97 connection slots used'))
    expect(row.querySelector('[data-source]')).toBeNull()
    expect(row).toHaveTextContent('Measured')
  })

  it('has no accessibility violations with the row', async () => {
    mountApp(OVERVIEW, worldWith({ capacity: capacity() }))
    const row = await slots()
    await waitFor(() => expect(row).toHaveTextContent('37 of 97'))
    expect(await axeViolations(document.body)).toEqual([])
  })
})
