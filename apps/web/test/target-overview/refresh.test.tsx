import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import {
  findingFixture,
  historyFixture,
  migrationStatusFixture,
  mountApp,
  operationFixture,
  project,
  streamFixture,
  World,
} from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const STAGING = 'shop/platform/staging'
const OVERVIEW = '/t/shop/platform/staging'

function readyWorld(): World {
  const world = new World()
  project(world)
  world.sample(STAGING)
  world.history = historyFixture()
  world.findings = [findingFixture()]
  world.migrations = migrationStatusFixture()
  world.stream = streamFixture()
  world.operations = [operationFixture()]
  return world
}

const count = (world: World, pattern: RegExp): number =>
  world.requests.filter((request) => pattern.test(request)).length

const READS = {
  health: /\/targets\/[^/]+\/health(\?|$)/,
  history: /\/health\/history/,
  findings: /\/findings/,
  migrations: /\/targets\/[^/]+\/migrations/,
  stream: /\/projects\/[^/]+\/migrations/,
  operations: /\/api\/v1\/operations\?/,
  target: /\/targets\/[^/]+(\?|$)/,
} as const

async function loaded(): Promise<void> {
  await screen.findByRole('table', { name: 'Open findings' })
  await screen.findByRole('table', { name: 'Recent operations on this target' })
  await screen.findByRole('table', { name: 'Stretches without samples' })
  await screen.findByText('1 applied')
}

const refreshButton = () =>
  within(screen.getByRole('group', { name: 'Refresh the reads of this page' })).getByRole(
    'button',
    {
      name: 'Refresh',
    },
  )
const result = () => document.querySelector('[data-slot="refresh-result"]') as HTMLElement

describe('the refresh button of the overview', () => {
  it('reads every block again now and stamps when the reads came back', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    await loaded()
    expect(result()).toBeEmptyDOMElement()
    const before = Object.fromEntries(
      Object.entries(READS).map(([name, pattern]) => [name, count(world, pattern)]),
    )
    await user.click(refreshButton())
    await waitFor(() => expect(result()).toHaveTextContent(/^Updated (just now|\d+ s ago)$/))
    for (const [name, pattern] of Object.entries(READS)) {
      expect(count(world, pattern), `${name} was read again`).toBe((before[name] ?? 0) + 1)
    }
    // The result is announced.
    expect(result()).toHaveAttribute('role', 'status')
  })

  it('shows that it is reading while the reads are out and again when they are back', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    await loaded()
    let release: () => void = () => {}
    world.delays.set(
      '/findings',
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    await user.click(refreshButton())
    await waitFor(() => expect(refreshButton()).toHaveAttribute('aria-busy', 'true'))
    expect(result()).toHaveTextContent('Reading again')
    release()
    await waitFor(() => expect(result()).toHaveTextContent(/^Updated/))
    expect(refreshButton()).not.toHaveAttribute('aria-busy')
  })

  it('counts the reads that failed and leaves each block its own failed state', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    await loaded()
    world.failures.set('/findings', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The findings did not come.',
    })
    await user.click(refreshButton())
    await waitFor(() => expect(result()).toHaveTextContent(/^Updated .* 1 of \d+ reads failed\./))
    expect(result()).toHaveTextContent('Each block shows its own state.')
    // The failed block is stale with the reason; the others show what they just read.
    const findings = document.querySelector('[data-block="findings"]') as HTMLElement
    await waitFor(() => expect(findings).toHaveTextContent('The findings did not come.'))
    expect(
      within(document.querySelector('[data-block="operations"]') as HTMLElement).getByRole(
        'table',
        {
          name: 'Recent operations on this target',
        },
      ),
    ).toBeInTheDocument()
  })

  it('says nothing was updated, and never "updated", when every read failed', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    await loaded()
    // Every block's read fails; the target itself, which the page's gate uses, still answers.
    for (const part of ['/health', '/findings', '/migrations', '/operations']) {
      world.failures.set(part, { status: 500, code: 'INTERNAL_ERROR', message: 'Down.' })
    }
    await user.click(refreshButton())
    await waitFor(() =>
      expect(result()).toHaveTextContent(/^Nothing was updated: all \d+ reads failed\.$/),
    )
    expect(result()).not.toHaveTextContent('Updated')
  })

  it('asks again only for the reads of this page', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    await loaded()
    const seen = world.requests.length
    await user.click(refreshButton())
    await waitFor(() => expect(result()).toHaveTextContent(/^Updated/))
    const added = world.requests.slice(seen)
    expect(added.length).toBeGreaterThan(0)
    for (const request of added) {
      expect(
        Object.values(READS).some((pattern) => pattern.test(request)),
        request,
      ).toBe(true)
    }
    // Reading is not probing: no request starts a probe.
    expect(added.every((request) => !/probe/.test(request))).toBe(true)
  })

  it('has no accessibility violations before and after a refresh', async () => {
    const user = userEvent.setup()
    mountApp(OVERVIEW, readyWorld())
    await loaded()
    expect(await axeViolations(document.body)).toEqual([])
    await user.click(refreshButton())
    await waitFor(() => expect(result()).toHaveTextContent(/^Updated/))
    expect(await axeViolations(document.body)).toEqual([])
  })
})
