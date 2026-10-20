import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { historyFixture, mountApp, project, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const STAGING = 'shop/platform/staging'
const OVERVIEW = '/t/shop/platform/staging'

function readyWorld(): World {
  const world = new World()
  project(world)
  world.sample(STAGING)
  world.history = historyFixture()
  return world
}

async function history(): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector('[data-block="history"]')
    if (el === null) throw new Error('no history block')
    return el as HTMLElement
  })
}

/** The `from` and `to` of the history reads the page made, oldest first. */
function asked(world: World): { from: string; to: string }[] {
  return world.requests
    .filter((request) => request.includes('/health/history'))
    .map((request) => {
      const query = new URL(request, 'http://x').searchParams
      return { from: query.get('from') ?? '', to: query.get('to') ?? '' }
    })
}

const seconds = (range: { from: string; to: string }): number =>
  (Date.parse(range.to) - Date.parse(range.from)) / 1_000

describe('the presets of the health history', () => {
  it('offers the last hour, 6 hours, 24 hours, 7 days and 14 days, with 24 hours chosen', async () => {
    mountApp(OVERVIEW, readyWorld())
    const block = await history()
    const names = within(block)
      .getAllByRole('button', { pressed: undefined })
      .map((button) => button.textContent)
    expect(names.slice(0, 5)).toEqual([
      'Last hour',
      'Last 6 hours',
      'Last 24 hours',
      'Last 7 days',
      'Last 14 days',
    ])
    expect(within(block).getByRole('button', { name: 'Last 24 hours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(block).getByRole('button', { name: 'Last hour' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('asks the server for exactly the hour or the 6 hours chosen, ending now', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    const block = await history()
    await waitFor(() => expect(asked(world).length).toBe(1))
    expect(seconds(asked(world)[0] ?? { from: '', to: '' })).toBe(24 * 3_600)
    await user.click(within(block).getByRole('button', { name: 'Last hour' }))
    await waitFor(() => expect(asked(world).length).toBe(2))
    const hour = asked(world)[1] ?? { from: '', to: '' }
    expect(seconds(hour)).toBe(3_600)
    // The server refuses a time in the future: the end is the request moment, in whole seconds.
    expect(Date.parse(hour.to)).toBeLessThanOrEqual(Date.now())
    expect(hour.to).toMatch(/\.000Z$/)
    await user.click(within(block).getByRole('button', { name: 'Last 6 hours' }))
    await waitFor(() => expect(asked(world).length).toBe(3))
    expect(seconds(asked(world)[2] ?? { from: '', to: '' })).toBe(6 * 3_600)
    expect(within(block).getByRole('button', { name: 'Last 6 hours' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('keeps a gap as a gap, with its cause, whatever range is chosen', async () => {
    const user = userEvent.setup()
    mountApp(OVERVIEW, readyWorld())
    const block = await history()
    await user.click(within(block).getByRole('button', { name: 'Last hour' }))
    const gaps = await within(block).findByRole('table', { name: 'Stretches without samples' })
    expect(gaps.textContent).toContain('ExponetDB was down (no live process or worker)')
    expect(block.querySelector('[data-slot="no-gaps"]')).toBeNull()
  })

  it('says what the server keeps and how far back a range can reach', async () => {
    mountApp(OVERVIEW, readyWorld())
    const block = await history()
    const note = block.querySelector('[data-slot="retention"]') as HTMLElement
    expect(note).toHaveTextContent(
      'ExponetDB keeps health samples for 14 days by default; an installation sets 3 to 60 days. A range reaches back at most 60 days, and nothing before the first kept sample is a gap.',
    )
  })

  it('shows a failed read of the hour as failed, never as an empty history', async () => {
    const user = userEvent.setup()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    const block = await history()
    await within(block).findByRole('table', { name: 'Stretches without samples' })
    world.failures.set('/health/history', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The samples did not come.',
    })
    await user.click(within(block).getByRole('button', { name: 'Last hour' }))
    expect(await within(block).findByText(/The samples did not come\./)).toBeInTheDocument()
    expect(within(block).queryByText('No sample in this range')).toBeNull()
  })
})

describe('a custom range of the health history', () => {
  // 2026-10-20, 12:30 local time: October 2026 has the 14th to the 16th in the month the calendar opens on.
  function freeze(): void {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date(2026, 9, 20, 12, 30, 0) })
  }
  const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

  async function pick(block: HTMLElement, first: string, last: string): Promise<void> {
    await user().click(within(block).getByRole('button', { name: /^Custom range:/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Custom range' })
    await user().click(within(dialog).getByRole('button', { name: new RegExp(first) }))
    await user().click(within(dialog).getByRole('button', { name: new RegExp(last) }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Custom range' })).toBeNull())
  }

  it('asks for the whole days chosen, in the local time zone, and shows them chosen', async () => {
    freeze()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    const block = await history()
    await waitFor(() => expect(asked(world).length).toBe(1))
    await pick(block, 'October 14th, 2026', 'October 16th, 2026')
    await waitFor(() => expect(asked(world).length).toBe(2))
    const range = asked(world)[1] ?? { from: '', to: '' }
    expect(range.from).toBe(new Date(2026, 9, 14).toISOString())
    expect(range.to).toBe(new Date(2026, 9, 17).toISOString())
    expect(
      within(block).getByRole('button', { name: 'Custom range: Oct 14, 2026 to Oct 16, 2026' }),
    ).toBeInTheDocument()
    // No preset is chosen any more.
    for (const name of [
      'Last hour',
      'Last 6 hours',
      'Last 24 hours',
      'Last 7 days',
      'Last 14 days',
    ]) {
      expect(within(block).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    }
    expect(block.querySelector('[data-slot="custom-range"]')).toHaveTextContent(
      'A custom range covers whole days in your time zone and ends now when its last day is today.',
    )
  })

  it('ends a range that includes today at the request moment, never later', async () => {
    freeze()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    const block = await history()
    await waitFor(() => expect(asked(world).length).toBe(1))
    await pick(block, 'October 19th, 2026', 'October 20th, 2026')
    await waitFor(() => expect(asked(world).length).toBe(2))
    const range = asked(world)[1] ?? { from: '', to: '' }
    expect(range.from).toBe(new Date(2026, 9, 19).toISOString())
    expect(Date.parse(range.to)).toBeLessThanOrEqual(Date.now())
    expect(Date.parse(range.to)).toBeGreaterThan(new Date(2026, 9, 20, 12, 29, 0).getTime())
  })

  it('does not offer a day in the future', async () => {
    freeze()
    mountApp(OVERVIEW, readyWorld())
    const block = await history()
    await user().click(within(block).getByRole('button', { name: /^Custom range:/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Custom range' })
    expect(within(dialog).getByRole('button', { name: /October 21st, 2026/ })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: /October 20th, 2026/ })).toBeEnabled()
  })

  it('goes back to a preset on a click, and forgets the days', async () => {
    freeze()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    const block = await history()
    await pick(block, 'October 14th, 2026', 'October 16th, 2026')
    await waitFor(() => expect(asked(world).length).toBe(2))
    await user().click(within(block).getByRole('button', { name: 'Last 7 days' }))
    await waitFor(() => expect(asked(world).length).toBe(3))
    expect(within(block).getByRole('button', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      within(block).getByRole('button', { name: 'Custom range: Choose dates' }),
    ).toBeInTheDocument()
    expect(block.querySelector('[data-slot="custom-range"]')).toBeNull()
  })

  it('shows a failed read of a custom range as failed, with the reason', async () => {
    freeze()
    const world = readyWorld()
    mountApp(OVERVIEW, world)
    const block = await history()
    await within(block).findByRole('table', { name: 'Stretches without samples' })
    world.failures.set('/health/history', {
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'The range is longer than 60 days.',
    })
    await pick(block, 'October 14th, 2026', 'October 16th, 2026')
    expect(await within(block).findByText(/The range is longer than 60 days\./)).toBeInTheDocument()
    expect(within(block).queryByText('No sample in this range')).toBeNull()
  })

  it('has no accessibility violations with the presets and the picker', async () => {
    mountApp(OVERVIEW, readyWorld())
    const block = await history()
    await within(block).findByRole('table', { name: 'Stretches without samples' })
    expect(await axeViolations(document.body)).toEqual([])
  })
})
