import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSectionCommands } from '../../src/features/target/section-commands.tsx'
import { SCHEMA_KINDS } from '../../src/lib/navigation/links.ts'
import { TARGET_NAV } from '../../src/shell/navigation.ts'
import { mountApp, project, World } from './support.tsx'

vi.mock('../../src/shell/app-shell.tsx', async () => ({
  AppShell: (await import('./test-shell.tsx')).TestShell,
}))

afterEach(cleanup)

const TARGET = {
  product: 'shop',
  project: 'platform',
  environment: 'staging',
  path: 'shop/platform/staging',
}

function worldWithProject(): World {
  const world = new World()
  project(world)
  world.sample('shop/platform/staging')
  return world
}

async function openPalette(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.keyboard('{Control>}k{/Control}')
  return screen.findByRole('dialog')
}

describe('the commands for the sections of a database', () => {
  it('builds one command for every section of the navigation, the schema kinds and the two ways into SQL', () => {
    const commands = buildSectionCommands(TARGET)
    const byId = new Map(commands.map((command) => [command.id, command]))
    for (const item of TARGET_NAV) {
      expect(byId.get(`target.section.${item.id}`)?.href, item.id).toBe(
        `/t/shop/platform/staging${item.suffix}`,
      )
    }
    for (const kind of SCHEMA_KINDS) {
      expect(byId.get(`target.schema.${kind}`)?.href, kind).toBe(
        `/t/shop/platform/staging/schema/${kind}`,
      )
    }
    expect(byId.get('target.sql.query')?.href).toBe('/t/shop/platform/staging/sql?mode=query')
    expect(byId.get('target.sql.draft')?.href).toBe('/t/shop/platform/staging/sql?mode=draft')
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length)
  })

  it('names them as commands, with "SQL" kept and the rest in sentence case', () => {
    const names = buildSectionCommands(TARGET).map((command) => command.name)
    expect(names).toContain('Go to overview')
    expect(names).toContain('Go to schema')
    expect(names).toContain('Go to SQL')
    expect(names).toContain('Go to compare environments')
    expect(names).toContain('Schema: tables')
    expect(names).toContain('Schema: materialized views')
    expect(names).toContain('Query the database')
    expect(names).toContain('Draft a change')
  })

  it('marks the pages that wait for a later wave, and only those (none since Wave 9)', () => {
    const commands = buildSectionCommands(TARGET)
    const marked = commands.filter((command) => command.badge !== undefined).map((c) => c.id)
    expect(marked.sort()).toEqual(
      TARGET_NAV.filter((item) => item.wave !== undefined)
        .map((item) => `target.section.${item.id}`)
        .sort(),
    )
  })
})

describe('the commands in the command menu', () => {
  it('lists them under the path of the database while a target page is open', async () => {
    const user = userEvent.setup()
    mountApp('/t/shop/platform/staging/locks', worldWithProject())
    const dialog = await openPalette(user)
    await within(dialog).findByText('Go to migrations')
    expect(within(dialog).getByText('shop/platform/staging')).toBeInTheDocument()
    for (const name of [
      'Go to schema',
      'Go to SQL',
      'Go to connections',
      'Go to locks',
      'Go to configuration',
      'Go to findings',
      'Go to drift',
      'Go to activity',
      'Go to performance',
      'Go to advisors',
      'Schema: tables',
      'Schema: views',
      'Query the database',
      'Draft a change',
    ]) {
      expect(within(dialog).getByText(name), name).toBeInTheDocument()
    }
  })

  it('goes to a section, a schema kind and the two SQL modes', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging', worldWithProject())
    for (const [query, path, search] of [
      ['go to migrations', '/t/shop/platform/staging/migrations', ''],
      ['schema: views', '/t/shop/platform/staging/schema/views', ''],
      ['query the database', '/t/shop/platform/staging/sql', 'mode=query'],
      ['draft a change', '/t/shop/platform/staging/sql', 'mode=draft'],
    ] as const) {
      const dialog = await openPalette(user)
      await within(dialog).findByText('Go to migrations')
      await user.type(within(dialog).getByRole('combobox'), query)
      await user.keyboard('{Enter}')
      await waitFor(() => expect(router.state.location.pathname).toBe(path))
      expect(new URLSearchParams(router.state.location.searchStr).toString()).toBe(search)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
  })

  it('opens the SQL page in the mode the command names', async () => {
    const user = userEvent.setup()
    mountApp('/t/shop/platform/staging', worldWithProject())
    const dialog = await openPalette(user)
    await user.type(within(dialog).getByRole('combobox'), 'draft a change')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(document.querySelector('[data-mode="draft"]')).not.toBeNull())
  })

  it('opens the performance page without a "not available yet" badge', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging', worldWithProject())
    const dialog = await openPalette(user)
    const option = await within(dialog).findByRole('option', { name: /Go to performance/ })
    expect(option).not.toHaveTextContent('Not available yet')
    await user.click(option)
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/staging/performance'),
    )
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Performance' }),
    ).toBeInTheDocument()
  })

  it('goes to the compare page of the database, the route another change builds', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging', worldWithProject())
    const dialog = await openPalette(user)
    await user.type(within(dialog).getByRole('combobox'), 'compare')
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(router.state.location.pathname).toBe('/t/shop/platform/staging/compare'),
    )
  })

  it('leaves with the target page: no section command is listed elsewhere', async () => {
    const user = userEvent.setup()
    const { router } = mountApp('/t/shop/platform/staging', worldWithProject())
    let dialog = await openPalette(user)
    await within(dialog).findByText('Go to migrations')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await router.navigate({ href: '/targets' })
    await screen.findByRole('heading', { level: 1, name: 'Databases' })
    dialog = await openPalette(user)
    expect(within(dialog).queryByText('Go to migrations')).toBeNull()
    expect(within(dialog).queryByText('Query the database')).toBeNull()
  })

  it('registers nothing for an address whose parameters are not slugs', async () => {
    const user = userEvent.setup()
    mountApp('/t/Shop/%3Cscript%3E/staging', new World())
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    const dialog = await openPalette(user)
    expect(within(dialog).queryByText('Query the database')).toBeNull()
    expect(within(dialog).queryByText(/script/i)).toBeNull()
  })

  it('follows the database when the person switches to another one', async () => {
    const user = userEvent.setup()
    const world = worldWithProject()
    world.add('billing/api/live', { tier: 'prod' })
    const { router } = mountApp('/t/shop/platform/staging', world)
    let dialog = await openPalette(user)
    await within(dialog).findByText('shop/platform/staging')
    await user.keyboard('{Escape}')
    await router.navigate({ href: '/t/billing/api/live' })
    await screen.findByRole('navigation', { name: 'Target sections' })
    dialog = await openPalette(user)
    await within(dialog).findByText('billing/api/live')
    expect(within(dialog).queryByText('shop/platform/staging')).toBeNull()
  })
})
