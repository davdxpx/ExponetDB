import '@testing-library/jest-dom/vitest'
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { BIDI, mountApp, placementFixture, project, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('../target/test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const STAGING = 'shop/platform/staging'
const OVERVIEW = '/t/shop/platform/staging'

async function hero(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2, name: /shop\/platform\/staging/ })
  return heading.closest('[data-block="hero"]') as HTMLElement
}

describe('the top of a target overview', () => {
  it('names the target with its tier and the first facts, each linking to its page', async () => {
    const world = new World()
    project(world)
    world.update(STAGING, { placement: placementFixture('agent') })
    mountApp(OVERVIEW, world)
    const block = await hero()
    expect(block).toHaveTextContent('17.2')
    expect(within(block).getByRole('link', { name: /applied|No ledger/ })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging/migrations',
    )
    expect(within(block).getByRole('link', { name: /open/ })).toHaveAttribute(
      'href',
      '/t/shop/platform/staging/findings',
    )
    // The backup fact reads the cluster's protection; a read that fails says so with its code,
    // never a state (test/wave9 covers the read that succeeds).
    expect(await within(block).findByText(/Could not read \(NOT_FOUND\)/)).toBeInTheDocument()
  })

  it('draws where it runs as the recorded layers and links the cluster, nothing invented', async () => {
    const world = new World()
    project(world)
    world.update(STAGING, { placement: placementFixture('agent') })
    mountApp(OVERVIEW, world)
    const block = await hero()
    const topology = block.querySelector('[data-topology="placed"]') as HTMLElement
    expect(topology).toHaveAttribute(
      'href',
      '/infrastructure/clusters/cls_00000000000000000000000001',
    )
    expect(topology).toHaveTextContent('db-01')
    expect(topology).toHaveTextContent('main')
    expect(topology).toHaveTextContent('Agent-managed')
    expect(topology.querySelector('a a, a button')).toBeNull()
    expect(topology.textContent).not.toMatch(/region|vCPU|GB/i)
  })

  it('says no placement is recorded instead of drawing one (none)', async () => {
    const world = new World()
    project(world)
    world.update(STAGING, { placement: null })
    mountApp(OVERVIEW, world)
    const block = await hero()
    expect(block.querySelector('[data-topology="none"]')).toHaveTextContent(
      'No placement is recorded for this target.',
    )
    expect(block.querySelector('[data-topology="placed"]')).toBeNull()
  })

  it('renders hostile server and cluster names as marked text inside the link', async () => {
    const world = new World()
    project(world)
    world.update(STAGING, {
      placement: { ...placementFixture('external'), serverName: `x${BIDI}<b>y</b>` },
    })
    mountApp(OVERVIEW, world)
    const topology = (await hero()).querySelector('[data-topology="placed"]') as HTMLElement
    expect(topology.textContent).toContain('⟨U+202E⟩')
    expect(topology.innerHTML).not.toContain('<b>')
    expect(topology).toHaveTextContent('External')
  })

  it('has no accessibility violations', async () => {
    const world = new World()
    project(world)
    world.update(STAGING, { placement: placementFixture('agent') })
    mountApp(OVERVIEW, world)
    await hero()
    expect(await axeViolations(document.body)).toEqual([])
  })
})
