import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TARGET_NAV, targetHref } from '../../src/shell/navigation.ts'
import { mountApp, project, World } from './support.tsx'

// The target pages are tested in the shortcut and command providers of the real shell, with the
// context bar in a header, but without the navigation rail the shell is still changing.
vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('./test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

function worldWithProject(): World {
  const world = new World()
  project(world)
  world.sample('shop/platform/staging')
  return world
}

const pageNotFound = () => screen.findByRole('heading', { level: 1, name: 'Page not found' })

describe('route parameters: anything that is not a slug is "page not found" and asks for nothing', () => {
  const hostile: readonly [string, string][] = [
    ['an uppercase product', '/t/Shop/platform/staging'],
    ['an uppercase environment', '/t/shop/platform/Staging'],
    ['a project that starts with a digit', '/t/shop/1platform/staging'],
    ['a slug of 40 characters', `/t/shop/platform/${'a'.repeat(40)}`],
    ['a slug of 40 characters as the product', `/t/${'a'.repeat(40)}/platform/staging`],
    ['an encoded slash', '/t/shop/platform/staging%2Fx'],
    ['an encoded slash in the product', '/t/shop%2Fplatform/x/staging'],
    ['two dots', '/t/shop/platform/..'],
    ['two encoded dots', '/t/shop/platform/%2E%2E'],
    ['two dots as the product', '/t/../platform/staging'],
    ['a right-to-left override', '/t/shop/platform/%E2%80%AEstaging'],
    ['a right-to-left override inside the slug', '/t/shop/platform/stag%E2%80%AEing'],
    ['a zero-width space', '/t/shop/platform/stag%E2%80%8Bing'],
    ['a trailing line feed', '/t/shop/platform/staging%0A'],
    ['an underscore', '/t/shop/platform/stag_ing'],
    ['a script tag', '/t/shop/platform/%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
    ['a section behind a bad slug', '/t/shop/platform/Staging/schema'],
  ]

  it.each(hostile)(
    "shows the shell's not-found page for %s and makes no request",
    async (_name, path) => {
      const world = worldWithProject()
      mountApp(path, world)
      expect(await pageNotFound()).toBeInTheDocument()
      expect(screen.getByRole('main')).toContainElement(
        screen.getByRole('heading', { level: 1, name: 'Page not found' }),
      )
      // Nothing of the parameters is rendered, and nothing but the session was asked for.
      expect(world.apiRequests).toEqual([])
      expect(screen.queryByRole('navigation', { name: 'Target' })).not.toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: 'Target sections' })).not.toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/script|Shop|platform|staging/i)
    },
  )

  it('shows "page not found" for a section that does not exist', async () => {
    const world = worldWithProject()
    mountApp('/t/shop/platform/staging/nope', world)
    expect(await pageNotFound()).toBeInTheDocument()
  })

  it('shows "page not found" for a schema kind that is not one, and for an object name', async () => {
    for (const kind of ['public.users', 'Tables', 'constructor']) {
      const world = worldWithProject()
      mountApp(`/t/shop/platform/staging/schema/${kind}`, world)
      expect(await pageNotFound()).toBeInTheDocument()
      expect(document.body.textContent).not.toContain(kind)
      cleanup()
    }
  })

  it('opens a schema kind', async () => {
    mountApp('/t/shop/platform/staging/schema/tables', worldWithProject())
    expect(await screen.findByRole('heading', { level: 1, name: 'Schema' })).toBeInTheDocument()
    expect(screen.getByText('Object kind: tables')).toBeInTheDocument()
  })
})

describe('a target page', () => {
  it('reads the target by its path and the environments of its project, and nothing else for the overview', async () => {
    const world = worldWithProject()
    mountApp('/t/shop/platform/staging', world)
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument()
    await waitFor(() =>
      expect(world.apiRequests).toContain(
        '/api/v1/targets?product=shop&project=platform&limit=200',
      ),
    )
    expect(world.apiRequests).toContain('/api/v1/targets/shop%2Fplatform%2Fstaging')
    // The overview needs no health, so the page does not ask for it.
    expect(world.apiRequests.some((request) => request.endsWith('/health'))).toBe(false)
  })

  it('lists every section in the navigation, the Wave 9 pages too, with the current one marked', async () => {
    mountApp('/t/shop/platform/staging/locks', worldWithProject())
    const nav = await screen.findByRole('navigation', { name: 'Target sections' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(TARGET_NAV.map((item) => item.label))
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      TARGET_NAV.map((item) =>
        targetHref({ product: 'shop', project: 'platform', environment: 'staging' }, item.suffix),
      ),
    )
    expect(within(nav).getByRole('link', { name: 'Locks' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
    expect(within(nav).getByRole('link', { name: 'Performance' })).toBeInTheDocument()
  })

  it('marks the overview as current only on the exact target path', async () => {
    mountApp('/t/shop/platform/staging', worldWithProject())
    const nav = await screen.findByRole('navigation', { name: 'Target sections' })
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      within(nav)
        .getAllByRole('link')
        .filter((l) => l.hasAttribute('aria-current')),
    ).toHaveLength(1)
  })

  it('navigates between sections without a page load', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging', worldWithProject())
    const nav = await screen.findByRole('navigation', { name: 'Target sections' })
    await user.click(within(nav).getByRole('link', { name: 'Migrations' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Migrations' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/t/shop/platform/staging/migrations')
  })

  it.each(TARGET_NAV.filter((item) => item.id !== 'overview' && !item.requires.includes('wave9')))(
    'has a page for $label that says it is not built yet',
    async (item) => {
      const world = worldWithProject()
      mountApp(`/t/shop/platform/staging${item.suffix}`, world)
      expect(await screen.findByRole('heading', { level: 1, name: item.label })).toBeInTheDocument()
      // Pages that need the target reachable wait for its health; give it a sample.
      expect(
        await screen.findByRole('heading', {
          level: 2,
          name: `${item.label} is not available yet`,
        }),
      ).toBeInTheDocument()
      expect(screen.getByText('This page of the Web App is not built yet.')).toBeInTheDocument()
    },
  )

  it.each(TARGET_NAV.filter((item) => item.requires.includes('wave9')))(
    'shows $label as a named "not available yet" state for Wave 9',
    async (item) => {
      const world = worldWithProject()
      mountApp(`/t/shop/platform/staging${item.suffix}`, world)
      expect(await screen.findByRole('heading', { level: 1, name: item.label })).toBeInTheDocument()
      expect(
        await screen.findByRole('heading', {
          level: 2,
          name: `${item.label} is not available yet`,
        }),
      ).toBeInTheDocument()
      expect(screen.getByText(/arrives with Wave 9/)).toBeInTheDocument()
      expect(
        screen.queryByText('This page of the Web App is not built yet.'),
      ).not.toBeInTheDocument()
    },
  )
})

describe('a target read that does not succeed', () => {
  it('shows a failed read with its code and a retry, never "not found" and never an empty page', async () => {
    const user = userEvent.setup()
    const world = worldWithProject()
    world.failures.set('/api/v1/targets/shop%2Fplatform%2Fstaging', {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'The control store did not answer.',
    })
    mountApp('/t/shop/platform/staging/migrations', world)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Could not read target' }),
    ).toBeInTheDocument()
    expect(screen.getByText('The control store did not answer.')).toBeInTheDocument()
    expect(screen.getByText('INTERNAL_ERROR')).toBeInTheDocument()
    expect(screen.getByText('This does not mean there is no target.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument()
    expect(screen.queryByText(/not available yet/)).not.toBeInTheDocument()
    // The page chrome stays, so the person can still move around.
    expect(screen.getByRole('heading', { level: 1, name: 'Migrations' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Target sections' })).toBeInTheDocument()

    world.failures.clear()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Migrations is not available yet' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Could not read target' })).not.toBeInTheDocument()
  })

  it("shows a forbidden read as a failed read too, with the server's code", async () => {
    const world = worldWithProject()
    world.failures.set('/api/v1/targets/shop%2Fplatform%2Fstaging', {
      status: 403,
      code: 'TARGET_NOT_IN_GRANT',
      message: "The token's grant does not include this target.",
    })
    mountApp('/t/shop/platform/staging', world)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Could not read target' }),
    ).toBeInTheDocument()
    expect(screen.getByText('TARGET_NOT_IN_GRANT')).toBeInTheDocument()
  })

  it.each([
    ['TARGET_NOT_FOUND', 404],
    ['NOT_FOUND', 404],
  ])(
    'shows "page not found" in the shell for %s, with no sign of the target',
    async (code, status) => {
      const world = worldWithProject()
      world.failures.set('/api/v1/targets/shop%2Fplatform%2Fstaging', { status, code })
      mountApp('/t/shop/platform/staging/schema', world)
      expect(await pageNotFound()).toBeInTheDocument()
      expect(screen.getByRole('main')).toContainElement(
        screen.getByRole('heading', { name: 'Page not found' }),
      )
      expect(screen.queryByRole('navigation', { name: 'Target sections' })).not.toBeInTheDocument()
      // The context bar is gone as well: neither the siblings nor the name of the target are shown.
      expect(screen.queryByRole('navigation', { name: 'Target' })).not.toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/staging|platform/i)
    },
  )

  it('shows "page not found" for a target the server does not know, like for one it hides', async () => {
    const world = worldWithProject()
    mountApp('/t/shop/platform/nowhere', world)
    expect(await pageNotFound()).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('nowhere')
  })

  it('keeps the activity of a suspended or decommissioned target readable, under a notice', async () => {
    const world = worldWithProject()
    world.update('shop/platform/staging', { state: 'suspended' })
    mountApp('/t/shop/platform/staging/activity', world)
    expect(await screen.findByText('This target is suspended')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument()
    cleanup()

    const other = worldWithProject()
    other.update('shop/platform/staging', { state: 'decommissioned' })
    mountApp('/t/shop/platform/staging/activity', other)
    expect(await screen.findByText('This target is decommissioned')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Activity' })).toBeInTheDocument()
  })

  it('names a suspended target instead of a page that needs it reachable', async () => {
    const world = worldWithProject()
    world.update('shop/platform/staging', { state: 'suspended' })
    mountApp('/t/shop/platform/staging/locks', world)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'This target is suspended' }),
    ).toBeInTheDocument()
  })
})

describe('pages that need the target to be reachable', () => {
  it('shows the unreachable state with the source and age of the sample', async () => {
    const world = worldWithProject()
    world.sample('shop/platform/staging', { state: 'unreachable' })
    mountApp('/t/shop/platform/staging/schema', world)
    const state = await screen.findByRole('region', { name: 'The target is unreachable' })
    expect(state).toHaveTextContent('Source: sampled. Observed')
    expect(world.apiRequests).toContain('/api/v1/targets/shop%2Fplatform%2Fstaging/health')
  })

  it.each(['sql', 'connections', 'locks'])('gates /%s on health too', async (section) => {
    const world = worldWithProject()
    world.sample('shop/platform/staging', { state: 'unreachable' })
    mountApp(`/t/shop/platform/staging/${section}`, world)
    expect(
      await screen.findByRole('region', { name: 'The target is unreachable' }),
    ).toBeInTheDocument()
  })

  it('cannot tell when health is unknown', async () => {
    const world = worldWithProject()
    world.sample('shop/platform/staging', { state: 'unknown', unknownBecause: 'never_sampled' })
    mountApp('/t/shop/platform/staging/schema', world)
    const state = await screen.findByRole('region', {
      name: 'Cannot tell whether the target is reachable',
    })
    expect(state).toHaveTextContent('The target has not been sampled yet.')
  })

  it('cannot tell when the health read fails, and reads it again on request', async () => {
    const user = userEvent.setup()
    const world = worldWithProject()
    world.failures.set('/health', { status: 500, code: 'INTERNAL_ERROR', message: 'It broke.' })
    mountApp('/t/shop/platform/staging/schema', world)
    const state = await screen.findByRole('region', {
      name: 'Cannot tell whether the target is reachable',
    })
    expect(state).toHaveTextContent('It broke. (INTERNAL_ERROR)')
    expect(screen.queryByText(/not available yet/)).not.toBeInTheDocument()

    world.failures.clear()
    await user.click(screen.getByRole('button', { name: 'Read health again' }))
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Schema is not available yet' }),
    ).toBeInTheDocument()
  })

  it('does not ask for health on a page that does not need it', async () => {
    const world = worldWithProject()
    world.sample('shop/platform/staging', { state: 'unreachable' })
    mountApp('/t/shop/platform/staging/migrations', world)
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Migrations is not available yet' }),
    ).toBeInTheDocument()
    expect(world.apiRequests.some((request) => request.endsWith('/health'))).toBe(false)
  })
})

describe('the production cue', () => {
  it('frames a production target and says "Production" in the header and the page title', async () => {
    mountApp('/t/shop/platform/production/migrations', worldWithProject())
    await screen.findByRole('heading', { level: 1, name: 'Migrations' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    const outlet = document.querySelector('[data-slot="target-outlet"]')
    expect(outlet).toHaveAttribute('data-production-frame')
    expect(outlet).toHaveClass('border-production')
    // The word is there, so the color is never the only signal: in the header and by the title.
    const bar = screen.getByRole('navigation', { name: 'Target' })
    expect(within(bar).getByText('Production')).toBeInTheDocument()
    const cue = document.querySelector('[data-slot="page-header-production-cue"]') as HTMLElement
    expect(within(cue).getByText('Production')).toBeInTheDocument()
  })

  it('shows none of it on a nonproduction target', async () => {
    mountApp('/t/shop/platform/staging/migrations', worldWithProject())
    await screen.findByRole('heading', { level: 1, name: 'Migrations' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'nonprod',
      ),
    )
    expect(document.querySelector('[data-production-frame]')).toBeNull()
    expect(document.querySelector('[data-slot="target-outlet"]')).not.toHaveClass(
      'border-production',
    )
    expect(screen.queryByText('Production')).not.toBeInTheDocument()
    const bar = screen.getByRole('navigation', { name: 'Target' })
    expect(within(bar).getByText('Non-production')).toBeInTheDocument()
  })

  it('goes by the tier field, never by the name: an environment called prod can be nonproduction', async () => {
    const world = new World()
    world.add('shop/platform/prod', { tier: 'nonprod' })
    mountApp('/t/shop/platform/prod/migrations', world)
    await screen.findByRole('heading', { level: 1, name: 'Migrations' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'nonprod',
      ),
    )
    expect(document.querySelector('[data-production-frame]')).toBeNull()
    expect(screen.queryByText('Production')).not.toBeInTheDocument()
  })

  it('and an environment called staging can be production', async () => {
    const world = new World()
    world.add('shop/platform/staging', { tier: 'prod' })
    mountApp('/t/shop/platform/staging/migrations', world)
    await screen.findByRole('heading', { level: 1, name: 'Migrations' })
    await waitFor(() =>
      expect(document.querySelector('[data-slot="target-layout"]')).toHaveAttribute(
        'data-tier',
        'production',
      ),
    )
    expect(document.querySelector('[data-production-frame]')).not.toBeNull()
  })

  it('shows no cue while the tier is not known (a failed read), and says so in the header', async () => {
    const world = worldWithProject()
    world.failures.set('/api/v1/targets/shop%2Fplatform%2Fproduction', {
      status: 500,
      code: 'INTERNAL_ERROR',
    })
    mountApp('/t/shop/platform/production/migrations', world)
    await screen.findByRole('heading', { level: 2, name: 'Could not read target' })
    expect(document.querySelector('[data-production-frame]')).toBeNull()
    expect(document.querySelector('[data-slot="target-layout"]')).not.toHaveAttribute('data-tier')
    // The list of environments still knows the tier of this one.
    const bar = screen.getByRole('navigation', { name: 'Target' })
    await waitFor(() => expect(within(bar).getByText('Production')).toBeInTheDocument())
  })
})

describe('accessibility of the layout', () => {
  async function violations(): Promise<string[]> {
    const { axeViolations } = await import('../../../../packages/ui/test/support/axe.ts')
    const layout = document.querySelector('[data-slot="target-layout"]')
    const bar = document.querySelector('[data-slot="target-context-bar"]')
    const found: string[] = []
    for (const root of [layout, bar]) {
      if (root !== null) found.push(...(await axeViolations(root)))
    }
    return found
  }

  it('has no axe violations on a nonproduction and a production target', async () => {
    mountApp('/t/shop/platform/staging/migrations', worldWithProject())
    await screen.findByRole('heading', { level: 2, name: 'Migrations is not available yet' })
    expect(await violations()).toEqual([])
    cleanup()

    mountApp('/t/shop/platform/production/migrations', worldWithProject())
    await screen.findByRole('heading', { level: 2, name: 'Migrations is not available yet' })
    await waitFor(() => expect(document.querySelector('[data-production-frame]')).not.toBeNull())
    expect(await violations()).toEqual([])
  })

  it('has no axe violations in the Wave 9, unreachable, cannot-tell and failed states', async () => {
    mountApp('/t/shop/platform/staging/backups', worldWithProject())
    await screen.findByRole('heading', { level: 2, name: 'Backups is not available yet' })
    expect(await violations()).toEqual([])
    cleanup()

    const unreachable = worldWithProject()
    unreachable.sample('shop/platform/staging', { state: 'unreachable' })
    mountApp('/t/shop/platform/staging/locks', unreachable)
    await screen.findByRole('region', { name: 'The target is unreachable' })
    expect(await violations()).toEqual([])
    cleanup()

    const failed = worldWithProject()
    failed.failures.set('/api/v1/targets/shop%2Fplatform%2Fstaging', {
      status: 500,
      code: 'INTERNAL_ERROR',
    })
    mountApp('/t/shop/platform/staging/locks', failed)
    await screen.findByRole('heading', { level: 2, name: 'Could not read target' })
    expect(await violations()).toEqual([])
  })
})
