import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import type { Target } from '../../src/features/target/queries.ts'
import { openFindingCount, targetNavItems } from '../../src/features/target/target-nav.tsx'
import { TARGET_NAV } from '../../src/shell/navigation.ts'
import { mountApp, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('./test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = 'shop/platform/staging'
const TARGET = { product: 'shop', project: 'platform', environment: 'staging', path: PATH }
const TARGET_READ = '/api/v1/targets/shop%2Fplatform%2Fstaging'

function worldWith(openFindingCount: number): World {
  const world = new World()
  world.add(PATH, { openFindingCount })
  return world
}

const nav = (): Promise<HTMLElement> => screen.findByRole('navigation', { name: 'Target sections' })
const badge = (): Element | null => document.querySelector('[data-slot="findings-badge"]')

describe('the Findings item of the rail and its count of open findings', () => {
  it('shows the number of open findings after the label, with the words for assistive technology', async () => {
    mountApp(`/t/${PATH}/locks`, worldWith(3))
    const tab = await within(await nav()).findByRole('link', { name: 'Findings 3 open findings' })
    expect(tab).toHaveAttribute('href', `/t/${PATH}/findings`)
    await waitFor(() => expect(badge()).not.toBeNull())
    expect(badge()).toHaveTextContent('3')
    expect(badge()).toHaveAttribute('aria-hidden', 'true')
    // Only the Findings item carries a count.
    expect(document.querySelectorAll('[data-slot="findings-badge"]')).toHaveLength(1)
    expect(within(await nav()).getByRole('link', { name: 'Locks' })).toHaveAccessibleName('Locks')
  })

  it('caps the number shown at 99+ and keeps the exact number in the words', async () => {
    mountApp(`/t/${PATH}`, worldWith(1204))
    const tab = await within(await nav()).findByRole('link', { name: /^Findings/ })
    await waitFor(() => expect(tab).toHaveAccessibleName('Findings 1204 open findings'))
    expect(badge()).toHaveTextContent('99+')
  })

  it('shows no badge for zero open findings, which the Findings page says after its own read', async () => {
    mountApp(`/t/${PATH}`, worldWith(0))
    const tab = await within(await nav()).findByRole('link', { name: 'Findings' })
    await screen.findByRole('heading', { level: 1, name: 'Overview' })
    expect(badge()).toBeNull()
    expect(tab).toHaveAccessibleName('Findings')
  })

  it('shows no badge, and never a zero, when the target read failed', async () => {
    const world = worldWith(7)
    world.failures.set(TARGET_READ, { status: 500, code: 'INTERNAL_ERROR' })
    mountApp(`/t/${PATH}`, world)
    const tab = await within(await nav()).findByRole('link', { name: 'Findings' })
    await screen.findAllByText(/INTERNAL_ERROR/)
    expect(badge()).toBeNull()
    expect(tab).toHaveAccessibleName('Findings')
    expect(document.body.textContent).not.toMatch(/Findings\s*0/)
  })

  it('drops the badge when the count is only an earlier read, stale since the refresh failed', async () => {
    const world = worldWith(4)
    const { queryClient } = mountApp(`/t/${PATH}`, world)
    const tab = await within(await nav()).findByRole('link', { name: /^Findings/ })
    await waitFor(() => expect(tab).toHaveAccessibleName('Findings 4 open findings'))
    world.failures.set(TARGET_READ, { status: 500, code: 'INTERNAL_ERROR' })
    await queryClient.refetchQueries({ queryKey: ['targets', 'detail', PATH] })
    await waitFor(() => expect(badge()).toBeNull())
    expect(tab).toHaveAccessibleName('Findings')
  })

  it('shows no badge while the target is read', async () => {
    const world = worldWith(5)
    let release: () => void = () => undefined
    world.delays.set(
      TARGET_READ,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp(`/t/${PATH}`, world)
    const tab = await within(await nav()).findByRole('link', { name: 'Findings' })
    expect(badge()).toBeNull()
    release()
    await waitFor(() => expect(tab).toHaveAccessibleName('Findings 5 open findings'))
  })

  it('has no accessibility violations with the badge', async () => {
    mountApp(`/t/${PATH}`, worldWith(2))
    await within(await nav()).findByRole('link', { name: 'Findings 2 open findings' })
    expect(await axeViolations()).toEqual([])
  })
})

describe('the count the rail may claim', () => {
  const target = (count: number): Target => new World().add(PATH, { openFindingCount: count })

  it('is the count only for a read that succeeded, and nothing for a partial one that holds none', () => {
    expect(
      openFindingCount({ state: 'ready', value: target(3), source: 'live', observedAt: '' }),
    ).toBe(3)
    expect(
      openFindingCount({
        state: 'partial',
        value: target(2),
        source: 'live',
        observedAt: '',
        missing: ['x'],
      }),
    ).toBe(2)
    expect(
      openFindingCount({ state: 'ready', value: target(0), source: 'live', observedAt: '' }),
    ).toBe(undefined)
  })

  it('is nothing for a loading, failed or stale read', () => {
    expect(openFindingCount({ state: 'loading' })).toBeUndefined()
    expect(
      openFindingCount({ state: 'failed', error: { code: 'NETWORK', message: 'x' } }),
    ).toBeUndefined()
    expect(
      openFindingCount({ state: 'stale', value: target(9), source: 'cached', observedAt: '' }),
    ).toBeUndefined()
  })

  it('puts the count on the Findings item only, and none when there is no count', () => {
    const withCount = targetNavItems(TARGET, `/t/${PATH}`, 3)
    expect(withCount.map((item) => item.count !== undefined)).toEqual(
      TARGET_NAV.map((item) => item.id === 'findings'),
    )
    expect(targetNavItems(TARGET, `/t/${PATH}`).every((item) => item.count === undefined)).toBe(
      true,
    )
  })
})
