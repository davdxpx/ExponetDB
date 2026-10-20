import '@testing-library/jest-dom/vitest'
import { cleanup, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountApp, project, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const STAGING = 'shop/platform/staging'
const OVERVIEW = '/t/shop/platform/staging'

const at = (): string => new Date().toISOString()

async function health(): Promise<HTMLElement> {
  return await waitFor(() => {
    const el = document.querySelector('[data-block="health"]')
    if (el === null) throw new Error('no health block')
    return el as HTMLElement
  })
}

describe('the values of a condition on the overview', () => {
  it('shows the slots, the oldest age and the transaction age the server sent, beside the count', async () => {
    const world = new World()
    project(world)
    world.sample(STAGING, {
      state: 'unhealthy',
      conditions: [
        {
          condition: 'connections_high',
          severity: 'warning',
          count: 212,
          observedAt: at(),
          values: { clientBackends: 212, usableSlots: 400 },
        },
        {
          condition: 'idle_in_transaction',
          severity: 'critical',
          count: 3,
          observedAt: at(),
          values: { oldestSeconds: 720, truncated: false },
        },
        {
          condition: 'xid_age_high',
          severity: 'warning',
          count: null,
          observedAt: at(),
          values: { xidAge: 512_000_000 },
        },
      ],
    })
    mountApp(OVERVIEW, world)
    const block = await health()
    const slots = await waitFor(() => {
      const el = block.querySelector('[data-detail="slots"]')
      if (el === null) throw new Error('no slots yet')
      return el as HTMLElement
    })
    expect(slots).toHaveTextContent('(Slots: 212 of 400 in use)')
    expect(block.querySelector('[data-detail="oldest"]')).toHaveTextContent('(Oldest: 12 min 0 s)')
    expect(block.querySelector('[data-detail="xidAge"]')).toHaveTextContent(
      '(Transaction ID age: 512,000,000)',
    )
    // The count is still there; the page colors and judges nothing on its own.
    const idle = within(block)
      .getByText(/Sessions are idle in a transaction/)
      .closest('li')
    expect(idle).toHaveTextContent('(3 affected)')
    expect(idle).toHaveAttribute('data-severity', 'critical')
  })

  it('shows nothing extra for a condition that carries no values', async () => {
    const world = new World()
    project(world)
    world.sample(STAGING, {
      state: 'degraded',
      conditions: [
        { condition: 'lock_waits', severity: 'warning', count: 2, observedAt: at() },
        {
          condition: 'stalled_sessions',
          severity: 'warning',
          count: 1,
          observedAt: at(),
          values: { truncated: true },
        },
      ],
    })
    mountApp(OVERVIEW, world)
    const block = await health()
    await within(block).findByText(/Sessions are waiting on locks/)
    expect(block.querySelector('[data-slot="condition-detail"]')).toBeNull()
  })
})
