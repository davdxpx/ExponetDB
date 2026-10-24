import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { healthViewOf } from '../../src/features/target/health-chip.tsx'
import type { Target } from '../../src/features/target/queries.ts'
import { mountApp, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('./test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const PATH = 'shop/platform/staging'
// The page's clock ticks every 10 seconds and rounds down, so ages are asked for with a margin.
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

function worldWith(over: Partial<Target> = {}): World {
  const world = new World()
  world.add(PATH, over)
  return world
}

const chip = (): Promise<HTMLElement> =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-slot="target-health"]')
    if (found === null) throw new Error('no health chip yet')
    return found
  })

describe('the health chip of the context bar', () => {
  it('shows the state of the sample with its word, and where it came from and how old it is on focus', async () => {
    const user = userEvent.setup()
    mountApp(
      `/t/${PATH}`,
      worldWith({
        health: { state: 'degraded', source: 'sampled', observedAt: ago(4 * 60_000 + 30_000) },
      }),
    )
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'degraded'))
    expect(found).toHaveTextContent('Health: Degraded')
    await user.tab()
    // Tab reaches the chip after the controls before it; walk to it.
    for (let i = 0; i < 6 && document.activeElement !== found; i++) await user.tab()
    expect(found).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('sampled, 4 min ago')
  })

  it.each([
    ['healthy', 'Healthy'],
    ['degraded', 'Degraded'],
    ['unhealthy', 'Unhealthy'],
    ['unreachable', 'Unreachable'],
    ['suspended', 'Suspended'],
    ['unknown', 'Unknown'],
  ] as const)('names a %s sample with the word %s', async (state, word) => {
    mountApp(
      `/t/${PATH}`,
      worldWith({ health: { state, source: 'sampled', observedAt: ago(10_000) } }),
    )
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', state))
    expect(found).toHaveTextContent(`Health: ${word}`)
  })

  it('reads a state it does not know as unknown, in the neutral colors, never as healthy', async () => {
    mountApp(
      `/t/${PATH}`,
      worldWith({
        health: {
          state: '<script>healthy</script>' as unknown as 'healthy',
          source: 'sampled',
          observedAt: ago(10_000),
        },
      }),
    )
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'unknown'))
    expect(found).toHaveTextContent('Unknown')
    expect(found.innerHTML).not.toContain('<script')
    expect(found.innerHTML).not.toContain('state-healthy')
  })

  it('says "No health sample" for a target that was never sampled, in the neutral colors', async () => {
    const user = userEvent.setup()
    mountApp(`/t/${PATH}`, worldWith({ health: null }))
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'none'))
    expect(found).toHaveTextContent('No health sample')
    expect(found.innerHTML).not.toContain('state-healthy')
    await user.hover(found)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'The target has not been sampled yet, so its health is not known.',
    )
  })

  it('shows a failed read as "Health not read", never as healthy and never as a state', async () => {
    const user = userEvent.setup()
    const world = worldWith({ health: { state: 'healthy', source: 'sampled', observedAt: ago(0) } })
    world.failures.set('/api/v1/targets/shop%2Fplatform%2Fstaging', {
      status: 500,
      code: 'INTERNAL_ERROR',
    })
    mountApp(`/t/${PATH}`, world)
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'notRead'))
    expect(found).toHaveTextContent('Health not read')
    expect(found.textContent).not.toContain('Healthy')
    expect(found.innerHTML).not.toContain('state-healthy')
    await user.hover(found)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'This does not mean it is unhealthy.',
    )
  })

  it('shows an earlier read as out of date, naming the last state and its age, never as current', async () => {
    const user = userEvent.setup()
    const world = worldWith({
      health: { state: 'healthy', source: 'sampled', observedAt: ago(3 * 60_000 + 30_000) },
    })
    const { queryClient } = mountApp(`/t/${PATH}`, world)
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'healthy'))
    world.failures.set('/api/v1/targets/shop%2Fplatform%2Fstaging', {
      status: 500,
      code: 'INTERNAL_ERROR',
    })
    await queryClient.refetchQueries({ queryKey: ['targets', 'detail', PATH] })
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'outdated'))
    expect(found).toHaveTextContent('Health out of date')
    expect(found.innerHTML).not.toContain('state-healthy')
    await user.hover(found)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'The last health read was healthy, sampled, 3 min ago. It is not shown as current.',
    )
  })

  it('shows a skeleton and no state while the target is read', async () => {
    const world = worldWith({ health: { state: 'healthy', source: 'sampled', observedAt: ago(0) } })
    let release: () => void = () => undefined
    world.delays.set(
      '/api/v1/targets/shop%2Fplatform%2Fstaging',
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    mountApp(`/t/${PATH}`, world)
    const bar = await screen.findByRole('navigation', { name: 'Target' })
    expect(bar).toBeInTheDocument()
    expect(document.querySelector('[data-slot="target-health"]')).toBeNull()
    release()
    await chip()
  })

  it('keeps only the glyph below lg, the word for assistive technology, and leaves a phone header', async () => {
    mountApp(
      `/t/${PATH}`,
      worldWith({ health: { state: 'healthy', source: 'sampled', observedAt: ago(10_000) } }),
    )
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'healthy'))
    expect(found.className).toContain('max-md:hidden')
    const word = within(found).getByText('Healthy').closest('span')
    expect(word?.className).toContain('max-lg:sr-only')
  })

  it('has no accessibility violations', async () => {
    mountApp(
      `/t/${PATH}`,
      worldWith({ health: { state: 'unhealthy', source: 'sampled', observedAt: ago(10_000) } }),
    )
    const found = await chip()
    await waitFor(() => expect(found).toHaveAttribute('data-health', 'unhealthy'))
    expect(await axeViolations()).toEqual([])
  })
})

describe('what the chip claims for each read', () => {
  const target = (health: Target['health']): Target => new World().add(PATH, { health })

  it('claims nothing while the read is loading and says "not read" when it failed', () => {
    expect(healthViewOf({ state: 'loading' })).toEqual({ kind: 'loading' })
    const failed = healthViewOf({ state: 'failed', error: { code: 'NETWORK', message: 'x' } })
    expect(failed).toMatchObject({ kind: 'chip', state: 'notRead' })
  })

  it('claims the sample for a ready or a partial read, and an earlier read as out of date', () => {
    const health = { state: 'healthy', source: 'sampled', observedAt: ago(0) } as const
    const ready = healthViewOf({
      state: 'ready',
      value: target(health),
      source: 'live',
      observedAt: ago(0),
    })
    expect(ready).toMatchObject({ kind: 'chip', state: 'healthy' })
    const stale = healthViewOf({
      state: 'stale',
      value: target(health),
      source: 'cached',
      observedAt: ago(0),
    })
    expect(stale).toMatchObject({ kind: 'chip', state: 'outdated' })
    const partial = healthViewOf({
      state: 'partial',
      value: target(health),
      source: 'live',
      observedAt: ago(0),
      missing: ['x'],
    })
    expect(partial).toMatchObject({ kind: 'chip', state: 'healthy' })
  })

  it('claims no sample for a target without one, in a read that is current or old', () => {
    expect(
      healthViewOf({ state: 'ready', value: target(null), source: 'live', observedAt: ago(0) }),
    ).toMatchObject({ kind: 'chip', state: 'none' })
    expect(
      healthViewOf({ state: 'stale', value: target(null), source: 'cached', observedAt: ago(0) }),
    ).toMatchObject({ kind: 'chip', state: 'outdated', explanation: { kind: 'earlier' } })
  })
})
