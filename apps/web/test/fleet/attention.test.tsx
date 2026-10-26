import '@testing-library/jest-dom/vitest'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axeViolations } from '../../../../packages/ui/test/support/axe.ts'
import { needsAttention } from '../../src/features/fleet/model.ts'
import { BIDI, iso, mountApp, targetFixture, World } from './support.tsx'

afterEach(cleanup)

type Health = NonNullable<ReturnType<typeof targetFixture>['health']>

function health(state: string, minutesAgo: number, source = 'sampled'): Health {
  return { state, source, observedAt: iso(minutesAgo * 60_000) } as Health
}

function worldOf(...targets: ReturnType<typeof targetFixture>[]): World {
  const world = new World()
  world.targetPages = [targets]
  return world
}

async function section(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', {
    level: 2,
    name: 'Targets that need attention',
  })
  const root = heading.closest('section')
  if (root === null) throw new Error('no attention section')
  return root
}

async function rowsOf(root: HTMLElement): Promise<string[]> {
  const list = await within(root).findByRole('list', { name: 'Targets with the worst health' })
  return within(list)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href') ?? '')
}

describe('the targets that need attention (model)', () => {
  const t = (path: string, state: string, minutesAgo = 1, over = {}) =>
    targetFixture(path, { health: health(state, minutesAgo), ...over })

  it('orders by severity, then the oldest observation first, then by path', () => {
    const same = '2026-10-20T08:00:00Z'
    const at = (path: string, state: string, observedAt: string) =>
      targetFixture(path, { health: { state, source: 'sampled', observedAt } as Health })
    const result = needsAttention([
      t('a/b/healthy', 'healthy'),
      at('a/b/degraded-new', 'degraded', '2026-10-20T08:30:00Z'),
      at('a/b/degraded-old', 'degraded', '2026-10-20T07:00:00Z'),
      t('a/b/unknown', 'unknown', 5),
      t('a/b/unhealthy', 'unhealthy', 2),
      t('a/b/unreachable', 'unreachable', 2),
      targetFixture('a/b/nosample', { health: null }),
      at('a/b/zzz', 'degraded', same),
      at('a/b/aaa', 'degraded', same),
    ])
    // Unknown sits before a target nobody ever sampled; equal severity and age fall back to the path.
    expect(result.rows.map((row) => row.path)).toEqual([
      'a/b/unhealthy',
      'a/b/unreachable',
      'a/b/degraded-old',
      'a/b/aaa',
      'a/b/zzz',
      'a/b/degraded-new',
      'a/b/unknown',
      'a/b/nosample',
    ])
    expect(result.count).toBe(8)
    expect(result.worst).toBe('unhealthy')
  })

  it('leaves out healthy, suspended and decommissioned targets, and counts a word it does not know as unknown', () => {
    const result = needsAttention([
      t('a/b/healthy', 'healthy'),
      t('a/b/suspended', 'suspended'),
      t('a/b/gone', 'unhealthy', 1, { state: 'decommissioned' }),
      t('a/b/odd', 'brand-new-state'),
    ])
    expect(result.rows.map((row) => row.path)).toEqual(['a/b/odd'])
    expect(result.worst).toBe('unknown')
    expect(needsAttention([t('a/b/healthy', 'healthy')])).toEqual({
      rows: [],
      count: 0,
      worst: undefined,
    })
  })

  it('shows at most the limit, and counts all of them', () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      t(`a/b/t${String(i).padStart(2, '0')}`, 'degraded'),
    )
    const result = needsAttention(many)
    expect(result.rows).toHaveLength(10)
    expect(result.count).toBe(14)
  })

  it('puts a target with an unreadable time first among equals (never confirmed)', () => {
    const result = needsAttention([
      t('a/b/known', 'degraded', 5),
      targetFixture('a/b/unreadable', {
        health: { state: 'degraded', source: 'sampled', observedAt: 'not a time' },
      }),
    ])
    expect(result.rows.map((row) => row.path)).toEqual(['a/b/unreadable', 'a/b/known'])
  })
})

describe('the overview section "Targets that need attention"', () => {
  it('lists the worst targets with path link, tier chip and health with source and age', async () => {
    const world = worldOf(
      targetFixture('shop/platform/staging', { health: health('degraded', 3) }),
      targetFixture('shop/platform/production', {
        tier: 'prod',
        health: health('unreachable', 2, 'sampled'),
      }),
      targetFixture('shop/billing/staging', { health: health('healthy', 1) }),
      targetFixture('acme/core/staging', { health: null }),
      targetFixture('acme/core/production', {
        tier: 'prod',
        state: 'suspended',
        health: health('suspended', 1),
      }),
    )
    mountApp('/', world)
    const root = await section()
    expect(await rowsOf(root)).toEqual([
      '/t/shop/platform/production',
      '/t/shop/platform/staging',
      '/t/acme/core/staging',
    ])
    const production = root.querySelector('[data-target]:not([data-tier="nonprod"])') as HTMLElement
    expect(production.querySelector('[data-tier="production"]')).not.toBeNull()
    expect(production.querySelector('[data-health="unreachable"]')).not.toBeNull()
    expect(production.textContent).toContain('sampled')
    expect(production.textContent).toMatch(/sampled, [0-9]+ min ago/)
    const link = within(root).getByRole('link', { name: /^shop\/platform\/production/ })
    expect(link).toHaveAttribute('href', '/t/shop/platform/production')
    // The whole row is the link, with nothing interactive inside it.
    expect(link.querySelector('a, button')).toBeNull()
    expect(link).toHaveAttribute('data-tone', 'production')
    const none = root.querySelector('[data-health="none"]')
    expect(none?.textContent).toContain('No health sample')
    expect(within(root).queryByRole('link', { name: /^shop\/billing\/staging/ })).toBeNull()
    expect(within(root).queryByRole('link', { name: /^acme\/core\/production/ })).toBeNull()
    expect(
      within(root).getByText('Needing attention: 3 of 5 targets read. Showing the worst 3.'),
    ).toBeVisible()
  })

  it('links "show all" to the list filtered by the worst health present', async () => {
    mountApp(
      '/',
      worldOf(
        targetFixture('shop/platform/staging', { health: health('degraded', 3) }),
        targetFixture('shop/platform/production', { tier: 'prod', health: health('unhealthy', 2) }),
      ),
    )
    const root = await section()
    await rowsOf(root)
    expect(within(root).getByRole('link', { name: 'Show all unhealthy targets' })).toHaveAttribute(
      'href',
      '/targets?health=unhealthy',
    )
    cleanup()

    mountApp('/', worldOf(targetFixture('acme/core/staging', { health: null })))
    const second = await section()
    await rowsOf(second)
    expect(
      within(second).getByRole('link', { name: 'Show all targets without a health sample' }),
    ).toHaveAttribute('href', '/targets?health=none')
  })

  it('shows ten rows at most and says how many need attention', async () => {
    const world = worldOf(
      ...Array.from({ length: 13 }, (_, i) =>
        targetFixture(`shop/p${String(i).padStart(2, '0')}/staging`, {
          health: health('degraded', 1),
        }),
      ),
    )
    mountApp('/', world)
    const root = await section()
    expect(await rowsOf(root)).toHaveLength(10)
    expect(
      within(root).getByText('Needing attention: 13 of 13 targets read. Showing the worst 10.'),
    ).toBeVisible()
  })

  it('makes one list request and none per target', async () => {
    const world = worldOf(
      targetFixture('shop/platform/staging', { health: health('degraded', 3) }),
      targetFixture('shop/platform/production', { tier: 'prod', health: health('unhealthy', 2) }),
    )
    mountApp('/', world)
    await rowsOf(await section())
    expect(world.gets('/api/v1/targets')).toHaveLength(1)
    expect(world.apiRequests.every((r) => !/\/targets\/[^?]/.test(r.path))).toBe(true)
  })

  it('says the count is "at least" and names what is missing when the list read stopped at its bound', async () => {
    const world = new World()
    world.targetPages = Array.from({ length: 6 }, (_, i) => [
      targetFixture(`shop/p${i}/staging`, { health: health('degraded', 1) }),
    ])
    mountApp('/', world)
    const root = await section()
    expect(
      await within(root).findByText(/More targets exist than the 1000 this page reads/),
    ).toBeVisible()
    expect(
      within(root).getByText(
        /Needing attention: at least 5 of 5 targets read, and more targets exist than this page reads\./,
      ),
    ).toBeVisible()
    expect(await rowsOf(root)).toHaveLength(5)
  })

  it('does not say nothing needs attention about a partial list in which all targets read are healthy', async () => {
    const world = new World()
    world.targetPages = Array.from({ length: 6 }, (_, i) => [
      targetFixture(`shop/p${i}/staging`, { health: health('healthy', 1) }),
    ])
    mountApp('/', world)
    const root = await section()
    expect(
      await within(root).findByText(
        'None of the targets read needs attention, but more targets exist than were read.',
      ),
    ).toBeVisible()
    expect(within(root).queryByText(/every target you may see is healthy/)).toBeNull()
    expect(within(root).queryByRole('list', { name: 'Targets with the worst health' })).toBeNull()
  })

  it('says no target needs attention only after a successful read of a complete list', async () => {
    mountApp(
      '/',
      worldOf(
        targetFixture('shop/platform/staging', { health: health('healthy', 3) }),
        targetFixture('shop/platform/production', { tier: 'prod', health: health('suspended', 2) }),
      ),
    )
    const root = await section()
    expect(
      await within(root).findByText(
        /no target needs attention: every target you may see is healthy or suspended/,
      ),
    ).toBeVisible()
    expect(within(root).queryByRole('list', { name: 'Targets with the worst health' })).toBeNull()
    expect(within(root).queryByRole('link', { name: /^Show all/ })).toBeNull()
  })

  it('shows a failed read of the list as failed, never as no target needing attention, and keeps the counts', async () => {
    const world = new World()
    world.failures.set('GET /api/v1/targets', {
      status: 500,
      code: 'INTERNAL',
      message: 'The registry did not answer.',
    })
    mountApp('/', world)
    const root = await section()
    expect(await within(root).findByText('The registry did not answer.')).toBeVisible()
    expect(within(root).getByText(/Could not read Target list/)).toBeVisible()
    expect(within(root).queryByText(/no target needs attention/)).toBeNull()
    expect(within(root).queryByRole('list', { name: 'Targets with the worst health' })).toBeNull()
    // The rest of the overview is read on its own.
    expect(await screen.findByRole('list', { name: 'Key numbers' })).toBeVisible()
  })

  it('shows an earlier read of the list as stale, with its age and a refresh, keeping the rows', async () => {
    const world = worldOf(targetFixture('shop/platform/staging', { health: health('degraded', 3) }))
    const { queryClient } = mountApp('/', world)
    const root = await section()
    await rowsOf(root)
    world.failures.set('GET /api/v1/targets', { status: 500, code: 'INTERNAL', message: 'Down.' })
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['targets', 'list'] })
    })
    await waitFor(() => expect(root.querySelector('[data-state="stale"]')).not.toBeNull())
    expect(root.querySelector('[data-state="stale"]')?.textContent).toMatch(
      /Showing an earlier read of .*Observed/,
    )
    expect(within(root).getByRole('button', { name: 'Refresh' })).toBeVisible()
    expect(await rowsOf(root)).toEqual(['/t/shop/platform/staging'])
  })

  it('shows a path that is not three slugs as marked text without a link', async () => {
    const world = worldOf(
      targetFixture(`../evil${BIDI}/x/<script>alert(1)</script>`, {
        health: health('unhealthy', 1),
      }),
      targetFixture('shop/platform/staging', { health: health('degraded', 1) }),
    )
    mountApp('/', world)
    const root = await section()
    const list = await within(root).findByRole('list', { name: 'Targets with the worst health' })
    expect(within(list).getAllByRole('link')).toHaveLength(1)
    expect(list.textContent).toContain('⟨U+202E⟩')
    expect(list.textContent).not.toContain(BIDI)
    expect(list.querySelector('script')).toBeNull()
  })

  it('has no accessibility violations', async () => {
    mountApp(
      '/',
      worldOf(
        targetFixture('shop/platform/staging', { health: health('degraded', 3) }),
        targetFixture('shop/platform/production', { tier: 'prod', health: health('unhealthy', 2) }),
        targetFixture('acme/core/staging', { health: null }),
      ),
    )
    await rowsOf(await section())
    expect(await axeViolations(document.body)).toEqual([])
  })
})
